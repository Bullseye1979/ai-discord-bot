// Version 4.0
// Kontext-Management mit MySQL + kanalbezogenen Summaries
//
// - Beim Initialisieren lädt der Context die letzten 5 Summaries (ASC: älteste → neueste)
//   und fügt sie NACH dem Systemprompt ein.
// - summarize():
//     * erzeugt & speichert eine neue Summary (aus context_log seit letzter Summary)
//     * setzt den Context anschließend auf: [Systemprompt] + [5 neueste Summaries in ASC]
//       + [alle Messages, die während der Summarization reingekommen sind]
// - add(): schreibt Messages in die DB (context_log) inkl. channel_id & UTC timestamp
//
// ENV erwartet (in .env):
//   DB_HOST, DB_USER, DB_PASSWORD (oder DB_PASS), DB_NAME (oder DB_DATABASE)

require('dotenv').config();
const mysql = require('mysql2/promise');
const axios = require("axios");

let pool;

// ---------- DB Helpers ----------

async function getPool() {
    if (!pool) {
        pool = await mysql.createPool({
            host: process.env.DB_HOST || '127.0.0.1',
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD || process.env.DB_PASS || '',
            database: process.env.DB_NAME || process.env.DB_DATABASE,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            timezone: 'Z',
            charset: 'utf8mb4_general_ci'
        });
        await ensureTables(pool);
    }
    return pool;
}

async function ensureTables(pool) {
    const conn = await pool.getConnection();
    try {
        await conn.query(`
            CREATE TABLE IF NOT EXISTS context_log (
              id INT AUTO_INCREMENT PRIMARY KEY,
              timestamp DATETIME NOT NULL,
              channel_id VARCHAR(32) NOT NULL,
              role VARCHAR(50) NOT NULL,
              sender VARCHAR(64) NOT NULL,
              content MEDIUMTEXT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);
        await conn.query(`
            CREATE TABLE IF NOT EXISTS summaries (
              id INT AUTO_INCREMENT PRIMARY KEY,
              timestamp DATETIME NOT NULL,
              channel_id VARCHAR(32) NOT NULL,
              summary MEDIUMTEXT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);
    } finally {
        conn.release();
    }
}

function toMySQLDateTime(date = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth()+1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function sanitizeName(s) {
    return String(s || 'system')
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_]/gi, '')
        .slice(0, 64);
}

// ---------- Context ----------

class Context {
    /**
     * @param {string} persona_arg
     * @param {string} instructions_arg
     * @param {Array}  tools_arg
     * @param {Object} toolRegistry_arg
     * @param {string} channelId  // NEU: damit wir Summaries & Logging kanalbezogen machen
     */
    constructor(persona_arg, instructions_arg, tools_arg, toolRegistry_arg, channelId = 'global') {
        this.messages = [];
        this.persona = persona_arg || '';
        this.instructions = instructions_arg || '';
        this.tools = tools_arg || [];
        this.toolRegistry = toolRegistry_arg || {};
        this.channelId = channelId;
        this.isSummarizing = false;

        // 1) Systemprompt an den Anfang
        const sys = `${this.persona}\n${this.instructions}`.trim();
        if (sys) {
            this.messages.push({ role: 'system', content: sys, name: 'system' });
        }

        // 2) Beim Start die 5 letzten Summaries laden (ASC) und in den Kontext legen
        //    (async kick-off; wir warten bewusst nicht hier, sondern kapseln in Promise,
        //     damit Konstruktor nicht blockt. Wer direkt danach Messages sendet, bekommt
        //     sie trotzdem in richtiger Reihenfolge, s.u.)
        this._initLoaded = this._injectInitialSummaries();
    }

    // Holt letzte 5 Summaries aus DB (älteste → neueste) und hängt sie nach dem Systemprompt an.
    async _injectInitialSummaries() {
        try {
            const db = await getPool();
            const [rows] = await db.execute(
                `SELECT timestamp, summary
                   FROM summaries
                  WHERE channel_id = ?
                  ORDER BY id DESC
                  LIMIT 5`,
                [this.channelId]
            );

            if (!rows || rows.length === 0) return;

            // DESC aus DB -> für Kontext ASC (älteste zuerst)
            const asc = [...rows].reverse();

            // Einfügen NACH dem Systemprompt (Index 0)
            const head = this.messages[0]?.role === 'system' ? 1 : 0;
            const summaryMsgs = asc.map(r => ({
                role: 'assistant',
                name: 'summary',
                content: r.summary
            }));
            this.messages.splice(head, 0, ...summaryMsgs);
        } catch (err) {
            console.error('[DB] Failed to load initial summaries:', err.message);
        }
    }

    // Standard add() + DB-Insert
    async add(role, sender, message) {
        const safeName = sanitizeName(sender);
        const entry = {
            role,
            content: String(message ?? ''),
            name: safeName
        };

        // WICHTIG: sicherstellen, dass initiale Summaries eingefügt wurden,
        // bevor wir Nutzer-Nachrichten anhängen (Reihenfolge im Kontext)
        try { await this._initLoaded; } catch {}

        this.messages.push(entry);

        // In DB loggen (best effort)
        try {
            const db = await getPool();
            await db.execute(
                `INSERT INTO context_log (timestamp, channel_id, role, sender, content)
                 VALUES (?, ?, ?, ?, ?)`,
                [toMySQLDateTime(new Date()), this.channelId, role, safeName, entry.content]
            );
        } catch (err) {
            console.error('[DB] insert context_log failed:', err.message);
        }

        return entry;
    }

    // Summarize gemäß der gewünschten Logik:
    // - Zusammenfassung über context_log seit letzter Summary
    // - Speichern in summaries
    // - Context danach = [System] + [5 neueste Summaries in ASC] + [währenddessen eingegangene Messages]
    async summarize() {
        if (this.isSummarizing) return this.messages;
        this.isSummarizing = true;

        // Nachrichten, die während der Summarization reinkommen, puffern
        const startIndex = this.messages.length;

        try {
            const db = await getPool();

            // 1) Zeitpunkt der letzten Summary für diesen Channel
            const [lastSum] = await db.execute(
                `SELECT timestamp FROM summaries WHERE channel_id = ? ORDER BY id DESC LIMIT 1`,
                [this.channelId]
            );
            const lastTs = lastSum?.[0]?.timestamp || null;

            // 2) Kontext aus context_log seit letzter Summary
            let q = `SELECT timestamp, role, sender, content
                       FROM context_log
                      WHERE channel_id = ?
                      ORDER BY id ASC`;
            const params = [this.channelId];
            if (lastTs) {
                q = `SELECT timestamp, role, sender, content
                       FROM context_log
                      WHERE channel_id = ? AND timestamp > ?
                      ORDER BY id ASC`;
                params.push(lastTs);
            }

            const [rows] = await db.execute(q, params);
            if (!rows || rows.length === 0) {
                // Nichts Neues – Context nicht umbauen, eventuell kamen Messages rein:
                return this.messages;
            }

            // 3) Prompt zusammenstellen
            const lines = rows.map(r =>
                `[${new Date(r.timestamp).toISOString()}] ${r.role.toUpperCase()}(${r.sender}): ${r.content}`
            ).join('\n');

            const systemPrompt = `Du erstellst sachliche, gut strukturierte Chat‑Zusammenfassungen.
Regeln:
- Kurz, aber vollständig: Entscheidungen, Aufgaben, wichtige Fakten, Links.
- Neutrale Sprache, sinnvolle Abschnitte/Überschriften, Bullet Points wo sinnvoll.
- Relevante Zitate nur bei Bedarf mit Namensnennung.
- Ausgabe auf Deutsch.`;

            // 4) Summary mit OpenAI erzeugen
            const payload = {
                model: "gpt-4-turbo",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: lines }
                ],
                max_tokens: 900
            };

            const aiRes = await axios.post(
                process.env.OPENAI_API_URL || "https://api.openai.com/v1/chat/completions",
                payload,
                { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
            );
            const summaryText = aiRes?.data?.choices?.[0]?.message?.content?.trim() || "";
            if (!summaryText) return this.messages;

            // 5) In summaries speichern
            await db.execute(
                `INSERT INTO summaries (timestamp, channel_id, summary) VALUES (?, ?, ?)`,
                [toMySQLDateTime(new Date()), this.channelId, summaryText]
            );

            // 6) Die in der Zwischenzeit ggf. eingegangenen Messages sichern
            const incoming = this.messages.slice(startIndex);

            // 7) Neuaufbau des Contexts: System + 5 neueste Summaries (ASC) + incoming
            const newMessages = [];

            const sys = `${this.persona}\n${this.instructions}`.trim();
            if (sys) newMessages.push({ role: 'system', content: sys, name: 'system' });

            // 5 letzte Summaries (DESC aus DB) -> für Kontext als ASC
            const [sumRowsDesc] = await db.execute(
                `SELECT timestamp, summary
                   FROM summaries
                  WHERE channel_id = ?
                  ORDER BY id DESC
                  LIMIT 5`,
                [this.channelId]
            );
            if (sumRowsDesc && sumRowsDesc.length > 0) {
                const asc = [...sumRowsDesc].reverse();
                for (const r of asc) {
                    newMessages.push({ role: 'assistant', name: 'summary', content: r.summary });
                }
            }

            // Danach evtl. währenddessen eingegangene Nachrichten anhängen
            newMessages.push(...incoming);

            // Kontext ersetzen
            this.messages = newMessages;

            return this.messages;
        } catch (err) {
            console.error('[SUMMARIZE ERROR]:', err.message);
            return this.messages;
        } finally {
            this.isSummarizing = false;
        }
    }

    // Kontext als kleine JSON‑Häppchen (für !context)
    async getContextAsChunks() {
        const maxLength = 1900;
        const json = this.messages.map(m => ({
            role: m.role,
            name: m.name,
            content: m.content
        }));
        const full = JSON.stringify(json, null, 2);
        const out = [];
        for (let i = 0; i < full.length; i += maxLength) {
            out.push(full.slice(i, i + maxLength));
        }
        return out;
    }

    // Optional: letzte N Summaries holen (DESC in DB)
    async getLastSummaries(limit = 5) {
        const db = await getPool();
        const [rows] = await db.execute(
            `SELECT timestamp, summary
               FROM summaries
              WHERE channel_id = ?
              ORDER BY id DESC
              LIMIT ?`,
            [this.channelId, Number(limit)]
        );
        return rows || [];
    }
}

module.exports = Context;

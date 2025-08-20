// Version 3.0
// Context-Management mit MySQL-Logging + Kanal-Zusammenfassungen
// - context_log: laufende Nachrichten
// - summaries: gespeicherte Zusammenfassungen pro Kanal
// - generateAndStoreSummary(channelId): fasst seit letzter Summary zusammen
// - getLastSummaries(channelId, n): holt letzte n Zusammenfassungen

require('dotenv').config();
const mysql = require('mysql2/promise');
const { getAI } = require('./aiService.js');

let pool;

// --- Hilfsfunktionen ---------------------------------------------------------

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
        await ensureTables();
    }
    return pool;
}

async function ensureTables() {
    const p = await pool.getConnection();
    try {
        await p.query(`
            CREATE TABLE IF NOT EXISTS context_log (
              id INT AUTO_INCREMENT PRIMARY KEY,
              timestamp DATETIME NOT NULL,
              channel_id VARCHAR(32) NOT NULL,
              role VARCHAR(50) NOT NULL,
              sender VARCHAR(64) NOT NULL,
              content MEDIUMTEXT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);
        await p.query(`
            CREATE TABLE IF NOT EXISTS summaries (
              id INT AUTO_INCREMENT PRIMARY KEY,
              timestamp DATETIME NOT NULL,
              channel_id VARCHAR(32) NOT NULL,
              summary MEDIUMTEXT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);
    } finally {
        p.release();
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

// --- Context-Klasse ----------------------------------------------------------

class Context {
    constructor(persona_arg, instructions_arg, tools_arg, toolRegistry_arg, channelId = 'global') {
        this.messages = [];
        this.persona = persona_arg;
        this.instructions = instructions_arg;
        this.tools = tools_arg;
        this.toolRegistry = toolRegistry_arg;
        this.channelId = channelId;

        const sys = `${this.persona || ''}\n${this.instructions || ''}`.trim();
        if (sys) this.add('system', 'system', sys).catch(() => {});
    }

    async add(role, sender, message) {
        const name = sanitizeName(sender);
        const now = new Date();
        const entry = {
            role,
            content: String(message ?? ''),
            name,
            timestamp: now.toISOString(),
            channelId: this.channelId
        };
        this.messages.push(entry);

        // DB-Insert (best effort)
        try {
            const db = await getPool();
            await db.execute(
                `INSERT INTO context_log (timestamp, channel_id, role, sender, content) VALUES (?, ?, ?, ?, ?)`,
                [toMySQLDateTime(now), this.channelId, role, name, entry.content]
            );
        } catch (err) {
            console.error('[DB ERROR] context_log insert failed:', err.message);
        }
        return entry;
    }

    async getContextAsChunks() {
        const maxLength = 1900;
        const jsonMessages = this.messages.map(m => ({
            role: m.role,
            name: m.name,
            timestamp: m.timestamp,
            channelId: m.channelId,
            content: m.content
        }));
        const full = JSON.stringify(jsonMessages, null, 2);
        const out = [];
        for (let i = 0; i < full.length; i += maxLength) {
            out.push(full.slice(i, i + maxLength));
        }
        return out;
    }

    /**
     * Erzeugt eine Zusammenfassung aller context_log-Einträge eines Kanals
     * seit der letzten gespeicherten Summary; speichert sie in summaries
     * und gibt den Text zurück. Gibt null zurück, wenn es nichts zu summarisieren gibt.
     */
    async generateAndStoreSummary(channelId = this.channelId) {
        const db = await getPool();

        // Letzten Summary-Zeitpunkt ermitteln
        const [lastSumRows] = await db.execute(
            `SELECT timestamp FROM summaries WHERE channel_id = ? ORDER BY id DESC LIMIT 1`,
            [channelId]
        );
        const lastTs = lastSumRows?.[0]?.timestamp || null;

        // Kontext seit letzter Summary laden
        let query = `SELECT timestamp, role, sender, content
                     FROM context_log
                     WHERE channel_id = ?
                     ORDER BY id ASC`;
        const params = [channelId];

        if (lastTs) {
            query = `SELECT timestamp, role, sender, content
                     FROM context_log
                     WHERE channel_id = ? AND timestamp > ?
                     ORDER BY id ASC`;
            params.push(lastTs);
        }

        const [rows] = await db.execute(query, params);
        if (!rows || rows.length === 0) {
            return null; // nichts Neues
        }

        // Text für die KI bauen (kompakt, aber vollständig)
        const lines = rows.map(r =>
            `[${new Date(r.timestamp).toISOString()}] ${r.role.toUpperCase()}(${r.sender}): ${r.content}`
        ).join('\n');

        // KI-Summary erzeugen
        const summaryCtx = new Context(
            "You are an expert meeting minutes generator.",
            `Summarize the following chat history for channel "${channelId}" **since the last summary**:
             - Keep it concise but **complete**: decisions, tasks, important facts, links, and key quotes.
             - Use a neutral, factual tone.
             - Structure with short headings and bullet points where it helps readability.
             - Preserve critical details and attributions (who said what) only when relevant.
             - Output language: German.`,
            [],
            {},
            channelId
        );
        await summaryCtx.add('user', 'system', lines);
        const summaryText = await getAI(summaryCtx, 900, 'gpt-4-turbo'); // ggf. Modell anpassen
        const finalText = (summaryText || '').trim();
        if (!finalText) return null;

        // In summaries speichern
        const now = new Date();
        await db.execute(
            `INSERT INTO summaries (timestamp, channel_id, summary) VALUES (?, ?, ?)`,
            [toMySQLDateTime(now), channelId, finalText]
        );

        return finalText;
    }

    /**
     * Letzte N Zusammenfassungen für einen Kanal
     */
    async getLastSummaries(channelId = this.channelId, limit = 5) {
        const db = await getPool();
        const [rows] = await db.execute(
            `SELECT timestamp, summary FROM summaries WHERE channel_id = ? ORDER BY id DESC LIMIT ?`,
            [channelId, Number(limit)]
        );
        return rows || [];
    }
}

module.exports = Context;

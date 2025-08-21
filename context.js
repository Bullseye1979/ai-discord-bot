// context.js — v4.7.1 (auf Basis v4.7)
// Neu:
//  - Vorhandene Summaries im Kontext klar markieren: <<<PRIOR_SUMMARY_START ...>>> ... <<<PRIOR_SUMMARY_END>>>
//  - System-Hinweis, wie diese Marker zu interpretieren sind (Kontext, nicht erneut zusammenfassen)
//  - Der Input an den Summarizer wird zwischen <<<BEGIN NEW MESSAGES>>> ... <<<END NEW MESSAGES>>> gekapselt

require("dotenv").config();
const mysql = require("mysql2/promise");
const { getAI } = require("./aiService.js");

let pool;

async function getPool() {
  if (!pool) {
    pool = await mysql.createPool({
      host: process.env.DB_HOST || "127.0.0.1",
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || process.env.DB_PASS || "",
      database: process.env.DB_NAME || process.env.DB_DATABASE,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      timezone: "Z",
      charset: "utf8mb4_general_ci",
    });
    await ensureTables(pool);
  }
  return pool;
}

async function ensureTables(pool) {
  const c = await pool.getConnection();
  try {
    await c.query(`
      CREATE TABLE IF NOT EXISTS context_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        timestamp DATETIME NOT NULL,
        channel_id VARCHAR(64) NOT NULL,
        role VARCHAR(50) NOT NULL,
        sender VARCHAR(64) NOT NULL,
        content MEDIUMTEXT NOT NULL,
        INDEX idx_ch_ts (channel_id, timestamp),
        INDEX idx_ch_id (channel_id, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await c.query(`
      CREATE TABLE IF NOT EXISTS summaries (
        id INT AUTO_INCREMENT PRIMARY KEY,
        timestamp DATETIME NOT NULL,
        channel_id VARCHAR(64) NOT NULL,
        summary MEDIUMTEXT NOT NULL,
        -- bis zu welcher context_log.id wurde zusammengefasst
        last_context_id INT NULL,
        INDEX idx_sum_ch_id (channel_id, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // falls Spalte bereits vorhanden, Fehler ignorieren
    await c.query(`
      ALTER TABLE summaries
      ADD COLUMN IF NOT EXISTS last_context_id INT NULL;
    `).catch(() => {});
  } finally {
    c.release();
  }
}

function toMySQLDateTime(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}
const sanitize = (s) =>
  String(s || "system")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/gi, "")
    .slice(0, 64);

class Context {
  constructor(persona = "", instructions = "", tools = [], toolRegistry = {}, channelId = "global") {
    this.messages = [];
    this.persona = persona || "";
    this.instructions = instructions || "";
    this.tools = tools || [];
    this.toolRegistry = toolRegistry || {};
    this.channelId = channelId;
    this.isSummarizing = false;

    // System: Persona + Instruktionen + kurzer Hinweis zu Summary-Markern
    const markerNote =
      "NOTE: Assistant messages named 'summary' or text enclosed by <<<PRIOR_SUMMARY_START...>>> and <<<PRIOR_SUMMARY_END>>> are prior summaries for context only. Do NOT re-summarize or quote them unless explicitly instructed.";
    const sys = [this.persona, this.instructions, markerNote].filter(Boolean).join("\n").trim();
    if (sys) this.messages.push({ role: "system", name: "system", content: sys });

    this._initLoaded = this._injectInitialSummaries();
  }

  async _injectInitialSummaries() {
    try {
      const db = await getPool();
      const [rowsDesc] = await db.execute(
        `SELECT timestamp, summary FROM summaries WHERE channel_id=? ORDER BY id DESC LIMIT 5`,
        [this.channelId]
      );
      if (!rowsDesc?.length) return;

      const asc = rowsDesc.slice().reverse(); // älteste -> neueste
      const head = this.messages[0]?.role === "system" ? 1 : 0;

      // Vorhandene Summary-Slots entfernen (falls vorhanden)
      let i = head;
      while (i < this.messages.length && this.messages[i]?.name === "summary") {
        this.messages.splice(i, 1);
      }

      // Zusammenfassungen mit klaren Markern einfügen
      const tagged = asc.map((r, idx) => {
        const ts = new Date(r.timestamp).toISOString();
        const body =
          `<<<PRIOR_SUMMARY_START ts=${ts} idx=${idx + 1}/${asc.length}>>>` +
          `\n${r.summary.trim()}\n` +
          `<<<PRIOR_SUMMARY_END>>>`;
        return { role: "assistant", name: "summary", content: body };
      });

      this.messages.splice(head, 0, ...tagged);
    } catch (e) {
      console.error("[DB] load initial summaries failed:", e.message);
    }
  }

  async add(role, sender, content) {
    const entry = { role, name: sanitize(sender), content: String(content ?? "") };
    try { await this._initLoaded; } catch {}
    this.messages.push(entry);

    try {
      const db = await getPool();
      await db.execute(
        `INSERT INTO context_log (timestamp, channel_id, role, sender, content) VALUES (?, ?, ?, ?, ?)`,
        [toMySQLDateTime(new Date()), this.channelId, role, entry.name, entry.content]
      );
    } catch (e) {
      console.error("[DB] insert context_log failed:", e.message);
    }
    return entry;
  }

  // ALLE Nachrichten >= cutoff (für Kontexteinbau nach Summary)
  async getMessagesAfter(cutoffMs) {
    const db = await getPool();
    const [rows] = await db.execute(
      `SELECT timestamp, role, sender, content
         FROM context_log
        WHERE channel_id=? AND timestamp >= ?
        ORDER BY id ASC`,
      [this.channelId, toMySQLDateTime(new Date(cutoffMs))]
    );
    return rows || [];
  }

  // Cursor-basierte Zusammenfassung (keine Dopplungen):
  // - NUR context_log.id > last_context_id
  // - UND timestamp <= cutoff
  async summarizeSince(cutoffMs, customPrompt = null) {
    if (this.isSummarizing) return this.messages;
    this.isSummarizing = true;

    try {
      const db = await getPool();

      // letzte Cursor-Position (bis wohin bereits zusammengefasst)
      const [lastSum] = await db.execute(
        `SELECT last_context_id FROM summaries WHERE channel_id=? ORDER BY id DESC LIMIT 1`,
        [this.channelId]
      );
      const lastCursor = lastSum?.[0]?.last_context_id ?? null;
      const cutoff = toMySQLDateTime(new Date(cutoffMs));

      let rows;
      if (lastCursor != null) {
        const [r] = await db.execute(
          `SELECT id, timestamp, role, sender, content
             FROM context_log
            WHERE channel_id=? AND id > ? AND timestamp <= ?
            ORDER BY id ASC`,
          [this.channelId, lastCursor, cutoff]
        );
        rows = r || [];
      } else {
        const [r] = await db.execute(
          `SELECT id, timestamp, role, sender, content
             FROM context_log
            WHERE channel_id=? AND timestamp <= ?
            ORDER BY id ASC`,
          [this.channelId, cutoff]
        );
        rows = r || [];
      }

      if (rows?.length) {
        const maxId = rows[rows.length - 1].id;

        // Prompt: ggf. aus Channel-Config, sonst Default
        const basePrompt =
          (customPrompt && customPrompt.trim()) ||
          `Summarize ONLY the content between <<<BEGIN NEW MESSAGES>>> and <<<END NEW MESSAGES>>>. Treat any earlier assistant messages or any content between <<<PRIOR_SUMMARY_START...>>> and <<<PRIOR_SUMMARY_END>>> as prior summaries (context only) — do NOT re-summarize or quote them. Focus strictly on in-character D&D events; ignore real-world chatter.`;

        console.debug(`[SUMMARY] Using cursor last_context_id=${lastCursor ?? "null"}, cutoff=${cutoff}`);
        console.debug(`[SUMMARY] Prompt used:\n${basePrompt}`);

        // Zu verdichtende Zeilen — zusätzlich hart markiert
        const payload = rows
          .map(
            (r) =>
              `[${new Date(r.timestamp).toISOString()}] #${r.id} ${r.role.toUpperCase()}(${r.sender}): ${r.content}`
          )
          .join("\n");
        const wrapped = `<<<BEGIN NEW MESSAGES>>>\n${payload}\n<<<END NEW MESSAGES>>>`;

        // Eigener Summarizer-Kontext (darf die Marker-Hinweise im System behalten)
        const sumCtx = new Context("You are a channel summary generator.", basePrompt, [], {}, this.channelId);
        await sumCtx.add("user", "system", wrapped);

        const summary = (await getAI(sumCtx, 900, "gpt-4-turbo"))?.trim() || "";

        if (summary) {
          await db.execute(
            `INSERT INTO summaries (timestamp, channel_id, summary, last_context_id)
             VALUES (?, ?, ?, ?)`,
            [toMySQLDateTime(new Date()), this.channelId, summary, maxId]
          );
        }
      } else {
        console.debug("[SUMMARY] No new messages since last cursor/cutoff → no new summary row inserted.");
      }

      // Kontext neu aufbauen: System + 5 Summaries (ASC) + alle >= Cutoff
      const [desc] = await db.execute(
        `SELECT timestamp, summary FROM summaries WHERE channel_id=? ORDER BY id DESC LIMIT 5`,
        [this.channelId]
      );
      const asc = (desc || []).slice().reverse();

      const newMsgs = [];
      const sys = [this.persona, this.instructions, 
        "NOTE: Assistant messages named 'summary' or text enclosed by <<<PRIOR_SUMMARY_START...>>> and <<<PRIOR_SUMMARY_END>>> are prior summaries for context only. Do NOT re-summarize or quote them unless explicitly instructed."
      ].filter(Boolean).join("\n").trim();
      if (sys) newMsgs.push({ role: "system", name: "system", content: sys });

      for (let i = 0; i < asc.length; i++) {
        const r = asc[i];
        const ts = new Date(r.timestamp).toISOString();
        const body =
          `<<<PRIOR_SUMMARY_START ts=${ts} idx=${i + 1}/${asc.length}>>>` +
          `\n${r.summary.trim()}\n` +
          `<<<PRIOR_SUMMARY_END>>>`;
        newMsgs.push({ role: "assistant", name: "summary", content: body });
      }

      const afterRows = await this.getMessagesAfter(cutoffMs);
      for (const r of afterRows) {
        newMsgs.push({ role: r.role, name: r.sender, content: r.content });
      }

      this.messages = newMsgs;
      return this.messages;
    } catch (e) {
      console.error("[SUMMARIZE] failed:", e);
      return this.messages;
    } finally {
      this.isSummarizing = false;
    }
  }

  async getLastSummaries(limit = 5) {
    const db = await getPool();
    const [rows] = await db.execute(
      `SELECT timestamp, summary FROM summaries WHERE channel_id=? ORDER BY id DESC LIMIT ?`,
      [this.channelId, Number(limit)]
    );
    return rows || [];
  }

  async getContextAsChunks() {
    const max = 1900;
    const full = JSON.stringify(
      this.messages.map((m) => ({ role: m.role, name: m.name, content: m.content })),
      null,
      2
    );
    const out = [];
    for (let i = 0; i < full.length; i += max) out.push(full.slice(i, i + max));
    return out;
  }
}

module.exports = Context;

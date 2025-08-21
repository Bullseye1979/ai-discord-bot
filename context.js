// context.js — v4.8 (Skip-Initial-Summaries + Cursor-Fix + SQL-Filter + Debug)
// Nach !summarize: Kontext = System + 5 Summaries (älteste→neueste) + ALLE Einzel-Messages >= Cutoff

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
        last_context_id INT NULL,
        INDEX idx_sum_ch_id (channel_id, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
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
  /**
   * @param {string} persona
   * @param {string} instructions
   * @param {Array} tools
   * @param {Object} toolRegistry
   * @param {string} channelId
   * @param {Object|boolean} optionsOrSkip - { skipInitialSummaries?: boolean } oder boolean (Back-Compat)
   */
  constructor(persona = "", instructions = "", tools = [], toolRegistry = {}, channelId = "global", optionsOrSkip = {}) {
    this.messages = [];
    this.persona = persona || "";
    this.instructions = instructions || "";
    this.tools = tools || [];
    this.toolRegistry = toolRegistry || {};
    this.channelId = channelId;
    this.isSummarizing = false;

    let opts = {};
    if (typeof optionsOrSkip === "boolean") {
      opts.skipInitialSummaries = optionsOrSkip;
    } else if (optionsOrSkip && typeof optionsOrSkip === "object") {
      opts = optionsOrSkip;
    }
    this._opts = { skipInitialSummaries: !!opts.skipInitialSummaries };

    const sys = `${this.persona}\n${this.instructions}`.trim();
    if (sys) this.messages.push({ role: "system", name: "system", content: sys });

    // Nur für "normale" Chat-Kontexte die letzten 5 Summaries injizieren;
    // Summarizer-Kontext setzt skipInitialSummaries = true
    this._initLoaded = this._opts.skipInitialSummaries ? Promise.resolve() : this._injectInitialSummaries();
  }

  async _injectInitialSummaries() {
    try {
      const db = await getPool();
      const [rowsDesc] = await db.execute(
        `SELECT timestamp, summary FROM summaries WHERE channel_id=? ORDER BY id DESC LIMIT 5`,
        [this.channelId]
      );
      if (!rowsDesc?.length) return;
      const asc = rowsDesc.slice().reverse();
      const head = this.messages[0]?.role === "system" ? 1 : 0;
      this.messages.splice(
        head,
        0,
        ...asc.map((r) => ({ role: "assistant", name: "summary", content: r.summary }))
      );
    } catch (e) {
      console.error("[DB] load initial summaries failed:", e.message);
    }
  }

  async add(role, sender, content) {
    const entry = { role, name: sanitize(sender), content: String(content ?? "") };
    try {
      await this._initLoaded;
    } catch {}
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

  // Cursor-basierte Zusammenfassung:
  // - Nur context_log.id > last_context_id
  // - timestamp <= cutoff
  // - strenger Filter: NUR user & kein "system"-Sender, keine Status-/Summary-/Marker-Texte
  async summarizeSince(cutoffMs, customPrompt = null) {
    if (this.isSummarizing) return this.messages;
    this.isSummarizing = true;

    try {
      const db = await getPool();

      // Letzte Cursor-Position holen
      const [lastSum] = await db.execute(
        `SELECT last_context_id FROM summaries WHERE channel_id=? ORDER BY id DESC LIMIT 1`,
        [this.channelId]
      );
      const lastCursor = lastSum?.[0]?.last_context_id ?? null;
      const cutoff = toMySQLDateTime(new Date(cutoffMs));

      // Auswahl der "neuen" Nachrichten (nur user, kein system-sender, keine Status/Summary/Marker)
      const commonWhere =
        `channel_id=? AND timestamp <= ? AND role='user' AND sender <> 'system'` +
        ` AND content NOT LIKE '⏳ %'` +
        ` AND content NOT LIKE '✅ %'` +
        ` AND content NOT LIKE 'Summary %'` +
        ` AND content NOT LIKE '<<<BEGIN NEW MESSAGES>>%'` +
        ` AND content NOT LIKE '<<<END NEW MESSAGES>>%'`;

      let rows = [];
      if (lastCursor != null) {
        const sql =
          `SELECT id, timestamp, role, sender, content
             FROM context_log
            WHERE ${commonWhere} AND id > ?
            ORDER BY id ASC`;
        const [r] = await db.execute(sql, [this.channelId, cutoff, lastCursor]);
        rows = r || [];
      } else {
        const sql =
          `SELECT id, timestamp, role, sender, content
             FROM context_log
            WHERE ${commonWhere}
            ORDER BY id ASC`;
        const [r] = await db.execute(sql, [this.channelId, cutoff]);
        rows = r || [];
      }

      let maxId = rows.length ? rows[rows.length - 1].id : null;

      // Debug: Übersicht der Auswahl
      console.debug(`[SUMMARY][DEBUG] Channel=${this.channelId} last_context_id=${lastCursor ?? "null"} cutoff=${cutoff} rows=${rows.length}`);
      if (rows.length) {
        console.debug(`[SUMMARY][DEBUG] Selected rows to summarize:`);
        for (const r of rows) {
          console.debug(`[${new Date(r.timestamp).toISOString()}] #${r.id} ${r.role.toUpperCase()}(${r.sender}): ${r.content}`);
        }
      }

      if (rows.length) {
        const prompt =
          (customPrompt && customPrompt.trim()) ||
          `You are a Dungeon Master writing a dramatic session recap. Summarize only the in-character Dungeons & Dragons events such as combat, roleplay, exploration, and dialogue. Completely ignore all out-of-character chatter like food orders, technical issues, jokes, or real-world references. If uncertain, only include messages that clearly advance the fantasy narrative. Write in English, using a vivid, high-fantasy style. Do not repeat events already present in earlier summaries; summarize only the NEW messages provided.`;

        console.debug(`[SUMMARY][DEBUG] Prompt used:\n${prompt}`);

        const text = rows
          .map(
            (r) =>
              `[${new Date(r.timestamp).toISOString()}] #${r.id} ${r.role.toUpperCase()}(${r.sender}): ${r.content}`
          )
          .join("\n");

        // Summarizer-Kontext OHNE Auto-Injection der letzten 5 Summaries!
        const sumCtx = new Context("You are a channel summary generator.", prompt, [], {}, this.channelId, { skipInitialSummaries: true });
        // Zusätzlich: Debug, was genau der Summarizer bekommt
        console.debug("[SUMMARY][DEBUG] ===== BEGIN SUMMARIZER CONTEXT (messages) =====");
        console.debug(JSON.stringify(sumCtx.messages.map((m, i) => ({ idx: i, role: m.role, name: m.name, content: m.content })), null, 2));
        console.debug("— adding payload —");
        await sumCtx.add("user", "system", text);
        console.debug(JSON.stringify(sumCtx.messages.map((m, i) => ({ idx: i, role: m.role, name: m.name, content: m.content })), null, 2));
        console.debug("[SUMMARY][DEBUG] ===== END SUMMARIZER CONTEXT (messages) =====");

        const summary = (await getAI(sumCtx, 900, "gpt-4-turbo"))?.trim() || "";

        if (summary) {
          await db.execute(
            `INSERT INTO summaries (timestamp, channel_id, summary, last_context_id)
             VALUES (?, ?, ?, ?)`,
            [toMySQLDateTime(new Date()), this.channelId, summary, maxId]
          );
        }
      } else {
        console.debug("[SUMMARY][DEBUG] No new user messages since last cursor/cutoff → no new summary row inserted.");
      }

      // Kontext neu aufbauen: System + 5 Summaries (ASC) + alle >= Cutoff
      const [desc] = await db.execute(
        `SELECT timestamp, summary FROM summaries WHERE channel_id=? ORDER BY id DESC LIMIT 5`,
        [this.channelId]
      );
      const asc = (desc || []).slice().reverse();

      const newMsgs = [];
      const sys = `${this.persona}\n${this.instructions}`.trim();
      if (sys) newMsgs.push({ role: "system", name: "system", content: sys });

      for (const r of asc) {
        newMsgs.push({ role: "assistant", name: "summary", content: r.summary });
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

// context.js — v4.9 (safe names + tool messages + DB like v4.8)
// - Sanitizes all message `name` fields to satisfy OpenAI ^[^\s<|\\/>]+$
// - Adds first-class support for tool messages (role:"tool" + tool_call_id)
// - Keeps DB schema/behavior from v4.8 intact

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

// ✅ Name-Whitelist für OpenAI: keine Leerzeichen/Sonderzeichen, max 64
function sanitizeName(s, fallback = "system") {
  return String(s || fallback)
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/gi, "")
    .slice(0, 64) || fallback;
}

class Context {
  constructor(persona = "", instructions = "", tools = [], toolRegistry = {}, channelId = "global", opts = {}) {
    const { skipInitialSummaries = false } = opts;
    this.messages = [];
    this.persona = persona || "";
    this.instructions = instructions || "";
    this.tools = tools || [];
    this.toolRegistry = toolRegistry || {};
    this.channelId = String(channelId);
    this.isSummarizing = false;

    const sys = `${this.persona}\n${this.instructions}`.trim();
    if (sys) {
      this.messages.push({ role: "system", name: "system", content: sys });
    }

    this._initLoaded = skipInitialSummaries ? Promise.resolve() : this._injectInitialSummaries();
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

  _rebuildSystemOnly() {
    const sys = `${this.persona}\n${this.instructions}`.trim();
    this.messages = sys ? [{ role: "system", name: "system", content: sys }] : [];
  }

  /**
   * Add a message to context + DB.
   * @param {"system"|"user"|"assistant"|"tool"} role
   * @param {string} sender - logical sender name (will be sanitized)
   * @param {string} content
   * @param {number|null} timestampMs
   * @param {{ alsoMemory?: boolean, tool_call_id?: string, function_name?: string }} opts
   */
  async add(role, sender, content, timestampMs = null, opts = {}) {
    const { alsoMemory = true, tool_call_id = null, function_name = null } = opts;

    // Persist basic fields in DB (no tool_call_id column -> we store only text)
    const db = await getPool();
    const ts = toMySQLDateTime(timestampMs ? new Date(timestampMs) : new Date());
    await db.execute(
      `INSERT INTO context_log (timestamp, channel_id, role, sender, content)
       VALUES (?, ?, ?, ?, ?)`,
      [
        ts,
        this.channelId,
        String(role || "user"),
        sanitizeName(sender || (role === "system" ? "system" : "user")),
        String(content || "")
      ]
    );

    if (alsoMemory) {
      const msg = {
        role: String(role || "user"),
        name: sanitizeName(
          role === "tool"
            ? (function_name || sender || "tool")
            : (sender || (role === "system" ? "system" : "user"))
        ),
        content: String(content || "")
      };

      // ✅ Tool-IDs korrekt anheften (für Chat Completions Pflicht nach tool_calls)
      if (role === "tool" && tool_call_id) {
        msg.tool_call_id = String(tool_call_id);
      }

      this.messages.push(msg);
      return msg;
    }
    return null;
  }

  /**
   * Convenience: Tool-Ergebnis hinzufügen (richtige Felder gesetzt)
   */
  async addToolResult(tool_call_id, functionName, content) {
    return this.add(
      "tool",
      functionName || "tool",
      content || "",
      null,
      { tool_call_id, function_name: functionName || "tool", alsoMemory: true }
    );
  }

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

  async summarizeSince(cutoffMs, customPrompt = null) {
    if (this.isSummarizing) {
      return { messages: this.messages, insertedSummaryId: null, usedMaxContextId: null };
    }
    this.isSummarizing = true;

    const DEFAULT_EXTRACTIVE_PROMPT = `
You are an EXTRACTIVE summarizer for chat logs.

Hard rules:
- Include only facts explicitly present in the SOURCE LINES.
- Do not invent names, places, or events. If unsure, omit.
- Each bullet MUST end with the source line IDs in square brackets, e.g. [#123,#128].
- If there are no in-character or otherwise valid events, output exactly: "No in-character events in this period."

Output:
- A short title.
- 3–10 bullet points, plain past tense, neutral tone (no purple prose).
`.trim();

    try {
      const db = await getPool();

      const [lastSum] = await db.execute(
        `SELECT id, last_context_id FROM summaries WHERE channel_id=? ORDER BY id DESC LIMIT 1`,
        [this.channelId]
      );
      const lastCursor = lastSum?.[0]?.last_context_id ?? null;
      const cutoff = toMySQLDateTime(new Date(cutoffMs));

      let rows = [];
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

      let maxId = rows.length ? rows[rows.length - 1].id : lastCursor;
      let insertedSummaryId = null;

      if (rows.length) {
        const text = rows
          .map(r => `[#${r.id}] ${String(r.role).toUpperCase()}(${r.sender}): ${r.content}`)
          .join("\n");

        const prompt =
          (customPrompt && customPrompt.trim()) ||
          (this.summaryPrompt && this.summaryPrompt.trim()) ||
          DEFAULT_EXTRACTIVE_PROMPT;

        const sumCtx = new Context(
          "You are a channel summary generator.",
          prompt,
          [],
          {},
          this.channelId,
          { skipInitialSummaries: true }
        );

        // in-memory only
        sumCtx.messages.push({ role: "user", name: "system", content: text });

        const summary = (await getAI(sumCtx, 900, "gpt-4-turbo", { temperature: 0.1 }))?.trim() || "";

        if (summary) {
          const [res] = await db.execute(
            `INSERT INTO summaries (timestamp, channel_id, summary, last_context_id)
             VALUES (?, ?, ?, ?)`,
            [toMySQLDateTime(new Date()), this.channelId, summary, maxId]
          );
          insertedSummaryId = res?.insertId ?? null;
        }
      } else {
        console.debug("[SUMMARY] No new rows since last cursor/cutoff.");
      }

      // Rebuild new context: system + last 5 summaries + all messages >= cutoff
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
        newMsgs.push({
          role: r.role,
          name: sanitizeName(r.sender || (r.role === "system" ? "system" : "user")),
          content: r.content
        });
      }

      this.messages = newMsgs;
      return { messages: this.messages, insertedSummaryId, usedMaxContextId: maxId };
    } catch (e) {
      console.error("[SUMMARIZE] failed:", e);
      return { messages: this.messages, insertedSummaryId: null, usedMaxContextId: null };
    } finally {
      this.isSummarizing = false;
    }
  }

  async getLastSummaries(limit = 5) {
    const db = await getPool();
    const [rows] = await db.execute(
      `SELECT id, timestamp, summary FROM summaries WHERE channel_id=? ORDER BY id DESC LIMIT ?`,
      [this.channelId, Number(limit)]
    );
    return rows || [];
  }

  async getMaxContextId() {
    const db = await getPool();
    const [rows] = await db.execute(
      `SELECT MAX(id) AS maxId FROM context_log WHERE channel_id=?`,
      [this.channelId]
    );
    return rows?.[0]?.maxId ?? null;
  }

  async bumpCursorToCurrentMax() {
    try {
      const db = await getPool();
      const maxId = await this.getMaxContextId();
      if (maxId == null) return null;
      await db.execute(
        `UPDATE summaries SET last_context_id=? WHERE channel_id=? ORDER BY id DESC LIMIT 1`,
        [maxId, this.channelId]
      );
      console.debug(`[SUMMARY][DEBUG] Cursor bumped to max context_log.id = ${maxId}`);
      return maxId;
    } catch (e) {
      console.error("[SUMMARY] bumpCursorToCurrentMax failed:", e.message);
      return null;
    }
  }

  async purgeChannelData() {
    const db = await getPool();
    const [r1] = await db.execute(`DELETE FROM context_log WHERE channel_id=?`, [this.channelId]);
    const [r2] = await db.execute(`DELETE FROM summaries WHERE channel_id=?`, [this.channelId]);
    this._rebuildSystemOnly();
    return {
      contextDeleted: r1?.affectedRows ?? 0,
      summariesDeleted: r2?.affectedRows ?? 0,
    };
  }

  async getContextAsChunks() {
    const max = 1900;
    const full = JSON.stringify(
      this.messages.map((m) => ({ role: m.role, name: m.name, content: m.content, tool_call_id: m.tool_call_id })),
      null,
      2
    );
    const out = [];
    for (let i = 0; i < full.length; i += max) out.push(full.slice(i, i + max));
    return out;
  }
}

module.exports = Context;

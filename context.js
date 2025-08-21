// context.js — v4.7 (Cursor-Fix mit last_context_id + Cutoff + SQL + Kontexteinbau)
// Nach !summarize: Kontext = System + 5 Summaries (älteste→neueste) + ALLE Einzel-Messages >= Cutoff (wie zuvor)

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
        -- NEU: bis zu welcher context_log.id wurde zusammengefasst
        last_context_id INT NULL,
        INDEX idx_sum_ch_id (channel_id, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Falls Spalte in bestehender DB fehlt: nachrüsten (MariaDB/10.3+ versteht IF NOT EXISTS)
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

    const sys = `${this.persona}\n${this.instructions}`.trim();
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

  // Cursor-basierte Zusammenfassung (keine Dopplungen):
  // - NUR context_log.id > last_context_id
  // - UND timestamp <= cutoff  (schützt vor "während des Laufs" gesendeten Nachrichten)
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

      let rows, maxId = null;

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

      if (rows.length) {
        maxId = rows[rows.length - 1].id;

        const prompt =
          (customPrompt && customPrompt.trim()) ||
          `Create a concise, structured chat summary in English. Only summarize in-character Dungeons & Dragons content. Ignore all real-world or out-of-character messages such as food orders or personal comments. Use a cinematic and immersive tone.`;

        console.debug(`[SUMMARY] Using cursor last_context_id=${lastCursor ?? "null"}, cutoff=${cutoff}`);
        console.debug(`[SUMMARY] Prompt used:\n${prompt}`);

        const text = rows
          .map(
            (r) =>
              `[${new Date(r.timestamp).toISOString()}] #${r.id} ${r.role.toUpperCase()}(${r.sender}): ${r.content}`
          )
          .join("\n");

        const sumCtx = new Context("You are a channel summary generator.", prompt, [], {}, this.channelId);
        await sumCtx.add("user", "system", text);

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

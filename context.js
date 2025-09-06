// context.js — clean v5.2 (Delta + Chunking)
// Conversation context with optional MySQL persistence, delta summaries, chunking, and user-window trimming.

require("dotenv").config();
const mysql = require("mysql2/promise");
const { getAI } = require("./aiService.js");

/* ----------------------------- DB bootstrap ----------------------------- */

let pool;

/** Format Date as MySQL DATETIME (UTC). */
function toMySQLDateTime(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/** Create tables if they do not exist. */
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

/** DB pool getter (lazy). */
async function getPool() {
  if (!pool) {
    pool = await mysql.createPool({
      host: process.env.MYSQL_HOST || "127.0.0.1",
      user: process.env.MYSQL_USER || "root",
      password: process.env.MYSQL_PASSWORD || "",
      database: process.env.MYSQL_DATABASE || "discordgpt",
      port: Number(process.env.MYSQL_PORT || 3306),
      connectionLimit: 5,
      charset: "utf8mb4",
      supportBigNumbers: true,
      dateStrings: true,
    });
    await ensureTables(pool);
  }
  return pool;
}

/* ----------------------------- Helpers for windowing ----------------------------- */

function isSystem(msg) { return msg?.role === "system"; }
function isSummary(msg) { return msg?.role === "assistant" && (msg?.name === "summary" || /^summary/i.test(msg?.name || "")); }
function isUser(msg) { return msg?.role === "user"; }
function isTool(msg) { return msg?.role === "tool"; }
function isAssistantToolCall(msg) { return msg?.role === "assistant" && Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0; }

/** Group messages into user-led blocks (system isolated, summaries separated). */
function buildBlocks(messages) {
  const hasSystem = messages.length && isSystem(messages[0]);
  const headIdx = hasSystem ? 1 : 0;

  const summaries = [];
  const body = [];
  for (let i = headIdx; i < messages.length; i++) {
    const m = messages[i];
    if (isSummary(m)) summaries.push(m);
    else body.push(m);
  }

  const blocks = [];
  let cur = [];
  const flush = () => { if (cur.length) { blocks.push(cur); cur = []; } };

  for (const m of body) {
    if (isUser(m)) { flush(); cur = [m]; }
    else { cur.push(m); }
  }
  flush();

  return { headIdx, summaries, blocks };
}

/** Drop the oldest k user blocks entirely (including assistant/tool messages in them). */
function dropOldestUserBlocks(messages, k) {
  if (!k || k <= 0) return 0;
  const hasSystem = messages.length && isSystem(messages[0]);
  const head = hasSystem ? [messages[0]] : [];

  const { summaries, blocks } = buildBlocks(messages);
  const userBlockIdx = blocks
    .map((b, i) => ({ i, hasUser: b.some(isUser) }))
    .filter(x => x.hasUser)
    .map(x => x.i);

  if (!userBlockIdx.length) return 0;

  const toKill = Math.min(k, userBlockIdx.length);
  const killSet = new Set(userBlockIdx.slice(0, toKill));
  const keptBlocks = blocks.filter((b, i) => !killSet.has(i));

  const rebuilt = [...head, ...summaries, ...keptBlocks.flat()];
  messages.splice(0, messages.length, ...rebuilt);
  return toKill;
}

/** Sanitize a display name into OpenAI-safe 'name'. */
function sanitizeName(input, fallback = "user") {
  return String(input || fallback)
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/gi, "")
    .slice(0, 64) || fallback;
}

/* ----------------------------- Context class ----------------------------- */

class Context {
  constructor(persona = "", instructions = "", tools = [], toolRegistry = {}, channelId = null, opts = {}) {
    const { skipInitialSummaries = false, persistToDB, summaryPrompt = "" } = opts;

    this.messages = [];
    this.persona = persona || "";
    this.instructions = instructions || "";
    this.tools = tools || [];
    this.toolRegistry = toolRegistry || {};
    this.channelId = channelId ? String(channelId) : null;
    this.summaryPrompt = summaryPrompt || "";
    this.persistent = typeof persistToDB === "boolean" ? persistToDB : !!this.channelId;

    this._maxUserMessages = null;
    this._prunePerTwoNonUser = true;
    this.isSummarizing = false;

    const sys = `${this.persona}\n${this.instructions}`.trim();
    if (sys) this.messages.push({ role: "system", name: "system", content: sys });

    this._initLoaded = (!this.persistent || skipInitialSummaries)
      ? Promise.resolve()
      : this._injectInitialSummaries();
  }

  /** Set the rolling window in user-blocks; null disables trimming. */
  setUserWindow(maxUserMessages, { prunePerTwoNonUser = true } = {}) {
    const n = Number(maxUserMessages);
    const cap = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    this._maxUserMessages = cap;
    this._prunePerTwoNonUser = !!prunePerTwoNonUser;
    if (cap != null) this._enforceUserWindowCap();
  }

  /** Count user-led blocks. */
  _countUserBlocks() {
    const { blocks } = buildBlocks(this.messages);
    return blocks.filter(b => b.some(isUser)).length;
  }

  /** Enforce the rolling window by dropping oldest user-blocks. */
  _enforceUserWindowCap() {
    if (this._maxUserMessages == null) return;
    const have = this._countUserBlocks();
    if (have > this._maxUserMessages) {
      dropOldestUserBlocks(this.messages, have - this._maxUserMessages);
    }
  }

  /** Post-add trimming hook to keep tool-call pairs and window intact. */
  _afterAddTrim(lastRole) {
    if (this._maxUserMessages == null) return;
    const L = this.messages.length;
    if (L >= 2 && lastRole === "tool") {
      const prev = this.messages[L - 2];
      if (isAssistantToolCall(prev)) dropOldestUserBlocks(this.messages, 2);
    }
    this._enforceUserWindowCap();
  }

  /** Keep only system and last DB summary in memory. */
  async collapseToSystemAndLastSummary() {
    const sys = `${this.persona}\n${this.instructions}`.trim();
    this.messages = sys ? [{ role: "system", name: "system", content: sys }] : [];
    try {
      const last = await this.getLastSummaries(1);
      const newest = last?.[0]?.summary;
      if (newest && newest.trim()) {
        this.messages.push({ role: "assistant", name: "summary", content: newest.trim() });
      }
    } catch (e) {
      console.warn("[collapseToSystemAndLastSummary] failed:", e.message);
    }
    return this.messages;
  }

  /** Inject the newest summary from DB into memory at startup. */
  async _injectInitialSummaries() {
    if (!this.persistent) return;
    try {
      const db = await getPool();
      const [rowsDesc] = await db.execute(
        `SELECT timestamp, summary FROM summaries WHERE channel_id=? ORDER BY id DESC LIMIT 1`,
        [this.channelId]
      );
      if (!rowsDesc?.length) return;
      const head = this.messages[0]?.role === "system" ? 1 : 0;
      this.messages.splice(head, 0, ...rowsDesc.slice().reverse().map(r => ({
        role: "assistant", name: "summary", content: r.summary
      })));
    } catch (e) {
      console.error("[DB] load initial summaries failed:", e.message);
    }
  }

  /** Rebuild memory to only the system message. */
  _rebuildSystemOnly() {
    const sys = `${this.persona}\n${this.instructions}`.trim();
    this.messages = sys ? [{ role: "system", name: "system", content: sys }] : [];
  }

  /** Add a message to memory and best-effort persist to DB. */
  async add(role, sender, content, timestampMs = null, { alsoMemory = true } = {}) {
    const safeRole = String(role || "user");
    const safeName = sanitizeName(sender, safeRole === "system" ? "system" : "user");
    const safeContent = String(content ?? "");

    if (alsoMemory) this.messages.push({ role: safeRole, name: safeName, content: safeContent });

    if (this.persistent) {
      try {
        const db = await getPool();
        const ts = toMySQLDateTime(timestampMs ? new Date(timestampMs) : new Date());
        await db.execute(
          `INSERT INTO context_log (timestamp, channel_id, role, sender, content)
           VALUES (?, ?, ?, ?, ?)`,
          [ts, this.channelId, safeRole, safeName, safeContent]
        );
      } catch (e) {
        console.warn("[DB][add] write failed (non-fatal):", e.message);
      }
    }

    if (alsoMemory) this._afterAddTrim(safeRole);
    return { role: safeRole, name: safeName, content: safeContent };
  }

  /** Fetch messages from DB at or after a UTC ms cutoff. */
  async getMessagesAfter(cutoffMs) {
    if (!this.persistent) return [];
    try {
      const db = await getPool();
      const [rows] = await db.execute(
        `SELECT timestamp, role, sender, content
           FROM context_log
          WHERE channel_id=? AND timestamp >= ?
          ORDER BY id ASC`,
        [this.channelId, toMySQLDateTime(new Date(cutoffMs))]
      );
      return rows || [];
    } catch (e) {
      console.warn("[DB][getMessagesAfter] read failed:", e.message);
      return [];
    }
  }

  /* ----------------------------- Summaries (Delta + Chunking) ----------------------------- */

  /**
   * Summarize logs since last cursor up to cutoff (UTC ms), store one new summary, and advance cursor.
   * - Keeps "delta" behavior (no full history pass).
   * - Uses adaptive chunking for long inputs, then a final pass with the channel's summaryPrompt (OOC filter).
   */
  async summarizeSince(cutoffMs, customPrompt = null) {
    if (!this.persistent || this.isSummarizing) {
      return { messages: this.messages, lastSummary: null, insertedSummaryId: null, usedMaxContextId: null };
    }
    this.isSummarizing = true;

    // Neutral extractive prompt for chunk passes (no story style, keep maximal detail)
    const CHUNK_EXTRACTIVE_PROMPT = `
You are producing a strictly extractive, chronological outline of the given chat log segment.
- Preserve concrete facts, names (exact spelling), dates/times, items, places, decisions, and numeric results.
- Avoid creativity. Do not invent, rephrase minimally, and DO NOT DROP details.
- Use compact bullet points (•) grouped by subtopic when helpful.
- If parts look like dice/math/meta/OOC, keep them but mark with [OOC?] tag; do not filter.
- Output only the outline (no intro/outro).
`.trim();

    // Default fallback if no channel summaryPrompt/custom is provided.
    const DEFAULT_FINAL_PROMPT = `
Summarize the provided chat logs concisely. Capture key points, decisions, follow-ups, references, and open questions.
Use bullet points, preserve dates/times, and include brief quotes only when necessary. Avoid speculation and omit trivial chit-chat.
`.trim();

    // Simple heuristics for chunking
    const MAX_INPUT_TOKENS_PER_CHUNK = 1800;   // rough word-count heuristic
    const MAX_FINAL_TOKENS = 3000;             // final recap budget
    const CHUNK_OUTPUT_TOKENS = 800;           // per chunk outline budget
    const FINAL_MODEL = "gpt-4o";              // stronger model for the final pass

    const tokenCount = (s) => String(s || "").trim().split(/\s+/).length;

    // Prepare DB fetch of delta
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

      const maxId = rows.length ? rows[rows.length - 1].id : lastCursor;
      let insertedSummaryId = null;

      if (rows.length) {
        // Build "raw lines" text (1 line per DB row)
        const makeLine = (r) => `[#${r.id}] ${r.role.toUpperCase()}(${r.sender}): ${r.content}`;
        const lines = rows.map(makeLine);

        // Decide if we need chunking
        const totalTokens = tokenCount(lines.join("\n"));
        const needsChunking = totalTokens > MAX_INPUT_TOKENS_PER_CHUNK * 1.2;

        let finalMaterial;
        if (!needsChunking) {
          // Single pass – send raw logs directly into final prompt
          finalMaterial = lines.join("\n");
        } else {
          // Chunk input by approximate token budget
          const chunks = [];
          let buf = [];
          let acc = 0;
          for (const ln of lines) {
            const t = tokenCount(ln);
            if (acc + t > MAX_INPUT_TOKENS_PER_CHUNK && buf.length) {
              chunks.push(buf.join("\n"));
              buf = [ln];
              acc = t;
            } else {
              buf.push(ln);
              acc += t;
            }
          }
          if (buf.length) chunks.push(buf.join("\n"));

          // Summarize each chunk extractively
          const chunkSummaries = [];
          for (let i = 0; i < chunks.length; i++) {
            const sumCtx = new Context(
              "You are a chunk summarizer.",
              CHUNK_EXTRACTIVE_PROMPT,
              [],
              {},
              null,
              { skipInitialSummaries: true, persistToDB: false }
            );
            sumCtx.messages.push({ role: "user", name: "system", content: chunks[i] });
            const s = (await getAI(sumCtx, CHUNK_OUTPUT_TOKENS, FINAL_MODEL))?.trim() || "";
            if (s) {
              chunkSummaries.push(`-- Chunk ${i + 1}/${chunks.length} --\n${s}`);
            }
          }
          finalMaterial = chunkSummaries.join("\n\n");
        }

        // Final pass with channel's summaryPrompt (OOC filter stays intact)
        const finalPrompt =
          (customPrompt && customPrompt.trim()) ||
          (this.summaryPrompt && this.summaryPrompt.trim()) ||
          DEFAULT_FINAL_PROMPT;

        const finalCtx = new Context(
          "You are a channel summary generator.",
          finalPrompt,
          [],
          {},
          null,
          { skipInitialSummaries: true, persistToDB: false }
        );

        // Feed the material as "THIS_SESSION_TRANSCRIPT (condensed if chunked)"
        finalCtx.messages.push({
          role: "user",
          name: "system",
          content: finalMaterial
        });

        const finalSummary = (await getAI(finalCtx, MAX_FINAL_TOKENS, FINAL_MODEL))?.trim() || "";

        if (finalSummary) {
          const [res] = await db.execute(
            `INSERT INTO summaries (timestamp, channel_id, summary, last_context_id)
             VALUES (?, ?, ?, ?)`,
            [toMySQLDateTime(new Date()), this.channelId, finalSummary, maxId]
          );
          insertedSummaryId = res?.insertId ?? null;
        }
      }

      let lastSummary = null;
      if (insertedSummaryId) {
        const [rowsOne] = await db.execute(`SELECT summary FROM summaries WHERE id=?`, [insertedSummaryId]);
        lastSummary = rowsOne?.[0]?.summary || null;
      }

      return { messages: this.messages, lastSummary, insertedSummaryId, usedMaxContextId: maxId };
    } catch (e) {
      console.error("[SUMMARIZE] failed:", e);
      return { messages: this.messages, lastSummary: null, insertedSummaryId: null, usedMaxContextId: null };
    } finally {
      this.isSummarizing = false;
    }
  }

  /** Get newest N summaries. */
  async getLastSummaries(limit = 1) {
    if (!this.persistent) return [];
    const db = await getPool();
    const [rows] = await db.execute(
      `SELECT id, timestamp, summary FROM summaries WHERE channel_id=? ORDER BY id DESC LIMIT ?`,
      [this.channelId, Number(limit)]
    );
    return rows || [];
  }

  /** Get current max context_log.id for this channel. */
  async getMaxContextId() {
    if (!this.persistent) return null;
    const db = await getPool();
    const [rows] = await db.execute(
      `SELECT MAX(id) AS maxId FROM context_log WHERE channel_id=?`,
      [this.channelId]
    );
    return rows?.[0]?.maxId ?? null;
  }

  /** Advance the summary cursor to the current max context id. */
  async bumpCursorToCurrentMax() {
    if (!this.persistent) return null;
    try {
      const db = await getPool();
      const maxId = await this.getMaxContextId();
      if (maxId == null) return null;
      await db.execute(
        `UPDATE summaries SET last_context_id=? WHERE channel_id=? ORDER BY id DESC LIMIT 1`,
        [maxId, this.channelId]
      );
      return maxId;
    } catch (e) {
      console.error("[SUMMARY] bumpCursorToCurrentMax failed:", e.message);
      return null;
    }
  }

  /** Delete all channel data and reset memory to system only. */
  async purgeChannelData() {
    if (!this.persistent) {
      this._rebuildSystemOnly();
      return { contextDeleted: 0, summariesDeleted: 0 };
    }
    try {
      const db = await getPool();
      const [r1] = await db.execute(`DELETE FROM context_log WHERE channel_id=?`, [this.channelId]);
      const [r2] = await db.execute(`DELETE FROM summaries WHERE channel_id=?`, [this.channelId]);
      this._rebuildSystemOnly();
      return { contextDeleted: r1?.affectedRows ?? 0, summariesDeleted: r2?.affectedRows ?? 0 };
    } catch (e) {
      console.error("[PURGE] failed:", e.message);
      this._rebuildSystemOnly();
      return { contextDeleted: 0, summariesDeleted: 0 };
    }
  }

  /** Return the in-memory context as ~1900-char chunks for display. */
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

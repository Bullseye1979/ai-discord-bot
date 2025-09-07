// context.js — v6.1 (ID-bounded Delta + Single Summary + classic chunk size + debug logging)
// - Persistenter Verlauf in MySQL
// - Inkrementelle Summaries (Delta über last_context_id)
// - EIN Summary-Pass pro Lauf (kein subsequentes Partitionieren)
// - Chunking: fixe, “klassische” Größe (≈1800 Wörter) mit Schwelle 1.2; Zwischenpass extrahiert faktenorientierte Bullets
// - Redo: löscht jüngste Summary + erzeugt sofort eine neue (gleiches Fenster via End-ID-Cap)
// - Debug: Ausführliche console.log-Ausgaben zu Fenster, Chunks und Chunk-Summaries.

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
    // kompatibel für ältere DBs
    await c.query(`ALTER TABLE summaries ADD COLUMN IF NOT EXISTS last_context_id INT NULL;`).catch(() => {});
  } finally {
    c.release();
  }
}

/** DB pool getter (lazy). */
async function getPool() {
  if (!pool) {
    // Bevorzugte ENV-Namen; Fallback auf alte MYSQL_*
    const host = process.env.DB_HOST || process.env.MYSQL_HOST || "127.0.0.1";
    const user = process.env.DB_USER || process.env.MYSQL_USER || "root";
    const password = process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || "";
    const database = process.env.DB_NAME || process.env.MYSQL_DATABASE || "discord_ai";
    const port = Number(process.env.DB_PORT || process.env.MYSQL_PORT || 3306);

    pool = await mysql.createPool({
      host, user, password, database, port,
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

  _countUserBlocks() {
    const { blocks } = buildBlocks(this.messages);
    return blocks.filter(b => b.some(isUser)).length;
  }

  _enforceUserWindowCap() {
    if (this._maxUserMessages == null) return;
    const have = this._countUserBlocks();
    if (have > this._maxUserMessages) {
      dropOldestUserBlocks(this.messages, have - this._maxUserMessages);
    }
  }

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

  /** Fetch messages from DB at or after a UTC ms cutoff. (legacy helper; nicht genutzt für Delta) */
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

  /* ----------------------------- Summaries (ID-bounded, single) ----------------------------- */

  /**
   * Summarize logs since last cursor using an ID window:
   * - startId = last_summary.last_context_id (or 0)
   * - endId   = MAX(context_log.id) at execution time (oder explizit übergeben)
   * Erzeugt GENAU EINE Summary über das gesamte Fenster und speichert sie mit last_context_id = endId.
   */
  async summarizeSince(cutoffMs, customPrompt = null, upperMaxContextId = null) {
    if (!this.persistent || this.isSummarizing) {
      return { messages: this.messages, lastSummary: null, insertedSummaryId: null, usedMaxContextId: null };
    }
    this.isSummarizing = true;

    const FINAL_MODEL = "gpt-4o";
    // Klassische Chunk-Größen – wie „vorher“
    const MAX_INPUT_TOKENS_PER_CHUNK = Number(process.env.SUMMARY_CHUNK_WORDS || process.env.SUMMARY_CHUNK_TOKENS || 1800);
    const CHUNK_THRESHOLD = Math.max(1.0, Number(process.env.SUMMARY_CHUNK_THRESHOLD || 1.2));
    const CHUNK_OUTPUT_TOKENS = Math.max(200, Number(process.env.SUMMARY_CHUNK_OUT_TOKENS || 800));
    const MAX_FINAL_TOKENS = Math.max(512, Number(process.env.SUMMARY_FINAL_TOKENS || 3000));

    // Final-Pass: neutral, verlustarm, strukturiert
    const DEFAULT_FINAL_PROMPT = `
You will receive compressed bullet outputs summarizing chat logs.
Your job: produce ONE consolidated, loss-minimizing summary for the whole window.

Rules:
- Preserve all concrete information (facts, decisions, tasks with owner & deadline, questions, numbers, URLs/IDs, code refs, errors).
- Deduplicate near-duplicates, but do not drop edge-cases. Keep exact names/terms.
- Preserve helpful chronology. If tags like [DECISION]/[TASK]/[QUESTION]/[NOTE]/[REF] appear, carry them through.
- Concise but complete; avoid filler/meta.

Output:
- A structured bullet list (sections like Decisions / Tasks / Open questions / Notes / References are welcome).
`.trim();

    // Chunk-Pass: faktenorientierte Extraktion, keine Prosa
    const CHUNK_PROMPT = `
You are compressing a slice of chat logs with minimal information loss.

Extract all content-carrying items as compact bullets, using tags where apt:
- [DECISION] decisions/outcomes
- [TASK] action items (include owner & deadline if present)
- [QUESTION] open questions/blockers
- [NOTE] factual notes/context/observations
- [REF] references (URLs, IDs, files, PRs, issues, msg IDs)

Rules:
- Keep exact names/IDs/terms; include numbers, dates, versions, error codes.
- Preserve local chronology within this slice.
- Skip pure pleasantries/emoji-only/acks unless they affect decisions/tasks.
- One item per line, terse. If uncertain, keep the item and mark with [?].

Output: only the bullet list, no headings.
`.trim();

    const tokenCount = (s) => String(s || "").trim().split(/\s+/).length;

    try {
      const db = await getPool();

      // Untere Grenze (exklusiv) = Cursor
      const [lastSum] = await db.execute(
        `SELECT id, last_context_id FROM summaries WHERE channel_id=? ORDER BY id DESC LIMIT 1`,
        [this.channelId]
      );
      const startId = lastSum?.[0]?.last_context_id ?? 0;

      // Obere Grenze (inklusiv) = End-ID jetzt, oder explizit gesetzt
      let endId = upperMaxContextId;
      if (endId == null) {
        const [mx] = await db.execute(
          `SELECT MAX(id) AS maxId FROM context_log WHERE channel_id=?`,
          [this.channelId]
        );
        endId = mx?.[0]?.maxId ?? null;
      }

      console.log(`[SUMMARY][${this.channelId}] window: startId=${startId} endId=${endId}`);

      if (endId == null || endId <= startId) {
        console.log(`[SUMMARY][${this.channelId}] nothing to summarize (no new rows).`);
        return { messages: this.messages, lastSummary: null, insertedSummaryId: null, usedMaxContextId: startId };
      }

      // Fenster laden: (startId, endId]
      let rows = [];
      if (startId > 0) {
        const [r] = await db.execute(
          `SELECT id, timestamp, role, sender, content
             FROM context_log
            WHERE channel_id=? AND id > ? AND id <= ?
            ORDER BY id ASC`,
          [this.channelId, startId, endId]
        );
        rows = r || [];
      } else {
        const [r] = await db.execute(
          `SELECT id, timestamp, role, sender, content
             FROM context_log
            WHERE channel_id=? AND id <= ?
            ORDER BY id ASC`,
          [this.channelId, endId]
        );
        rows = r || [];
      }

      console.log(`[SUMMARY][${this.channelId}] loaded rows: ${rows.length}`);

      if (!rows.length) {
        console.log(`[SUMMARY][${this.channelId}] empty window after load.`);
        return { messages: this.messages, lastSummary: null, insertedSummaryId: null, usedMaxContextId: startId };
      }

      // Roh-Lines aufbauen (mit IDs für Nachvollziehbarkeit)
      const makeLine = (r) => `[#${r.id}] ${r.role.toUpperCase()}(${r.sender}): ${r.content}`;
      const lines = rows.map(makeLine);

      const finalPrompt =
        (customPrompt && customPrompt.trim()) ||
        (this.summaryPrompt && this.summaryPrompt.trim()) ||
        DEFAULT_FINAL_PROMPT;

      // Chunking-Entscheidung (einmalig über das gesamte Fenster)
      const allJoined = lines.join("\n");
      const totalTokens = tokenCount(allJoined);
      const needsChunking = totalTokens > MAX_INPUT_TOKENS_PER_CHUNK * CHUNK_THRESHOLD;

      console.log(
        `[SUMMARY][${this.channelId}] tokenCount≈${totalTokens} ` +
        `limit≈${MAX_INPUT_TOKENS_PER_CHUNK} threshold=${CHUNK_THRESHOLD} ` +
        `=> needsChunking=${needsChunking}`
      );

      let finalMaterial;
      if (!needsChunking) {
        // kein Chunking: Material direkt in den Final-Pass geben
        finalMaterial = allJoined;
        console.log(`[SUMMARY][${this.channelId}] NO CHUNKING; passing full window to final pass.`);
      } else {
        // in Chunks schneiden (zeilenbasiert)
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

        console.log(
          `[SUMMARY][${this.channelId}] CHUNKING: produced ${chunks.length} chunks ` +
          `(maxPerChunk≈${MAX_INPUT_TOKENS_PER_CHUNK}).`
        );

        // RAW-Chunk-Ausgabe
        chunks.forEach((c, i) => {
          const words = tokenCount(c);
          console.log(`\n[SUMMARY][${this.channelId}] ===== RAW CHUNK ${i + 1}/${chunks.length} (words≈${words}) =====\n${c}\n`);
        });

        // Zwischenpass: faktenorientierte Bullets je Chunk
        const chunkSummaries = [];
        for (let i = 0; i < chunks.length; i++) {
          const sumCtx = new Context(
            "You compress chat logs with minimal information loss.",
            CHUNK_PROMPT,
            [],
            {},
            null,
            { skipInitialSummaries: true, persistToDB: false }
          );
          sumCtx.messages.push({ role: "user", name: "system", content: chunks[i] });
          const s = (await getAI(sumCtx, CHUNK_OUTPUT_TOKENS, FINAL_MODEL))?.trim() || "";

          // Chunk-Summary-Ausgabe
          console.log(`\n[SUMMARY][${this.channelId}] ----- CHUNK SUMMARY ${i + 1}/${chunks.length} (maxTokens=${CHUNK_OUTPUT_TOKENS}) -----\n${s}\n`);

          if (s) chunkSummaries.push(s);
        }
        // Konsolidiertes Material für den Final-Pass
        finalMaterial = chunkSummaries.join("\n");
      }

      // Final-Pass: konsolidieren, deduplizieren, Struktur geben – ohne Inhalte zu verlieren
      const finalCtx = new Context(
        "You consolidate chunk summaries with minimal loss.",
        finalPrompt,
        [],
        {},
        null,
        { skipInitialSummaries: true, persistToDB: false }
      );
      finalCtx.messages.push({ role: "user", name: "system", content: finalMaterial });

      const finalSummary = (await getAI(finalCtx, MAX_FINAL_TOKENS, FINAL_MODEL))?.trim() || "";

      let insertedSummaryId = null;
      if (finalSummary) {
        const [res] = await db.execute(
          `INSERT INTO summaries (timestamp, channel_id, summary, last_context_id)
           VALUES (?, ?, ?, ?)`,
          [toMySQLDateTime(new Date()), this.channelId, finalSummary, endId]
        );
        insertedSummaryId = res?.insertId ?? null;
        console.log(`[SUMMARY][${this.channelId}] FINAL SUMMARY inserted: id=${insertedSummaryId}, last_context_id=${endId}, length=${finalSummary.length}`);
      } else {
        console.log(`[SUMMARY][${this.channelId}] FINAL SUMMARY was empty — no DB insert.`);
      }

      let lastSummary = null;
      if (insertedSummaryId) {
        const [rowsOne] = await db.execute(`SELECT summary FROM summaries WHERE id=?`, [insertedSummaryId]);
        lastSummary = rowsOne?.[0]?.summary || null;
      }

      return { messages: this.messages, lastSummary, insertedSummaryId, usedMaxContextId: endId };
    } catch (e) {
      console.error("[SUMMARIZE] failed:", e);
      return { messages: this.messages, lastSummary: null, insertedSummaryId: null, usedMaxContextId: null };
    } finally {
      this.isSummarizing = false;
    }
  }

  /** Delete newest summary row for this.channelId. Returns deleted row id or null. */
  async deleteLastSummary() {
    if (!this.persistent) return null;
    try {
      const db = await getPool();
      const [rows] = await db.execute(
        `SELECT id FROM summaries WHERE channel_id=? ORDER BY id DESC LIMIT 1`,
        [this.channelId]
      );
      const lastId = rows?.[0]?.id ?? null;
      if (!lastId) return null;
      await db.execute(`DELETE FROM summaries WHERE id=?`, [lastId]);
      return lastId;
    } catch (e) {
      console.error("[SUMMARY] deleteLastSummary failed:", e.message);
      return null;
    }
  }

  /**
   * Redo: löscht jüngste Summary und erzeugt sofort eine neue über dasselbe Fenster.
   * Nutzt die End-ID (last_context_id) der gelöschten Summary als Obergrenze.
   */
  async redoLastSummary(cutoffMs, customPrompt = null) {
    if (!this.persistent) {
      return { messages: this.messages, lastSummary: null, insertedSummaryId: null, usedMaxContextId: null };
    }
    // Obergrenze sichern, bevor wir löschen
    let endCapId = null;
    try {
      const db = await getPool();
      const [rows] = await db.execute(
        `SELECT last_context_id FROM summaries WHERE channel_id=? ORDER BY id DESC LIMIT 1`,
        [this.channelId]
      );
      endCapId = rows?.[0]?.last_context_id ?? null;
      console.log(`[SUMMARY][${this.channelId}] REDO endCapId from last summary: ${endCapId}`);
    } catch {}

    await this.deleteLastSummary(); // Cursor fällt auf vorherige Summary zurück
    // Exakt dieses Fenster erneut zusammenfassen
    return this.summarizeSince(null, customPrompt, endCapId);
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

  /* ----------------------------- replace summary text only ----------------------------- */

  /** Fetch newest context_log row for this channel. */
  async _getLastContextRow() {
    const db = await getPool();
    const [rows] = await db.execute(
      `SELECT id, timestamp, role, sender, content
         FROM context_log
        WHERE channel_id=?
        ORDER BY id DESC
        LIMIT 1`,
      [this.channelId]
    );
    return rows?.[0] || null;
  }

  /**
   * Replace ONLY the text of the newest summary with the content of the newest context_log row.
   * - Keeps timestamp, id, and last_context_id of the summary unchanged.
   * - If no summary exists: returns { ok:false, reason:"NO_SUMMARY" }.
   * - If no context_log row exists: returns { ok:false, reason:"NO_CONTEXT_LOG" }.
   */
  async replaceLastSummaryWithLastLog() {
    if (!this.persistent) return { ok: false, reason: "NOT_PERSISTENT" };
    try {
      const db = await getPool();

      const lastLog = await this._getLastContextRow();
      if (!lastLog) return { ok: false, reason: "NO_CONTEXT_LOG" };

      const [sumRows] = await db.execute(
        `SELECT id FROM summaries WHERE channel_id=? ORDER BY id DESC LIMIT 1`,
        [this.channelId]
      );
      const sum = sumRows?.[0] || null;
      if (!sum) return { ok: false, reason: "NO_SUMMARY" };

      await db.execute(
        `UPDATE summaries SET summary=? WHERE id=?`,
        [String(lastLog.content || ""), sum.id]
      );

      return { ok: true, updated: sum.id };
    } catch (e) {
      console.error("[SUMMARY] replaceLastSummaryWithLastLog failed:", e.message);
      return { ok: false, reason: "ERROR", error: e?.message || String(e) };
    }
  }
}

module.exports = Context;

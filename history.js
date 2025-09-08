// history.js — v2.0 (raw | passthrough | qa with channel-safe context windows)
// - raw:         returns raw rows exactly as stored (no AI) — preserves current behavior incl. summaries
// - passthrough: returns a single concatenated text block for direct context injection (no AI)
// - qa:          finds matches by keywords, expands ±10 messages in same channel, dedupes & answers via GPT-4.1
//
// Notes:
// * Multiple channels write to the same table -> context windows are fetched with channel filter & LIMIT
// * ORDER BY and channel scoping are enforced here; the model never builds full SQL.
//
// Requires: mysql2/promise-based pool export from ./db.js as { pool }
// Optional: getAI/Context for qa mode (no AI used in raw/passthrough)

const { pool } = require("./db.js");
const { reportError } = require("./error.js");
const { getAI } = require("./aiService.js");
const Context = require("./context.js");

// ---------- Tunables ----------
const QA_MODEL = "gpt-4.1";
const QA_TOKENS = 1200;

const MATCH_LIMIT = 30;          // Max number of keyword matches to expand
const CTX_BEFORE = 10;           // window size: messages before the match (same channel)
const CTX_AFTER = 10;            // window size: messages after the match (same channel)
const RAW_LIMIT_DEFAULT = 200;   // default limit when no time window is provided

// ---------- Utilities ----------
function parseArgs(toolFunction) {
  try {
    return typeof toolFunction.arguments === "string"
      ? JSON.parse(toolFunction.arguments || "{}")
      : (toolFunction.arguments || {});
  } catch {
    return {};
  }
}

/** Split query into AND-terms. Handles quoted phrases: "murphy ist vampir" */
function extractTerms(q) {
  const s = String(q || "").trim();
  if (!s) return [];
  const terms = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(s))) {
    const term = (m[1] || m[2] || "").trim();
    if (term) terms.push(term);
  }
  // Remove duplicates & trivial tokens
  const uniq = [...new Set(terms.map(t => t.toLowerCase()))].filter(t => t.length >= 2);
  return uniq;
}

/** Build WHERE fragments for AND-like search on 'content' */
function buildAndLike(whereTerms) {
  if (!whereTerms?.length) return { sql: "1=1", params: [] };
  const parts = whereTerms.map(() => "content LIKE ?");
  const params = whereTerms.map(t => `%${t}%`);
  return { sql: parts.join(" AND "), params };
}

/** Fetch last N messages in channel, ASC */
async function fetchLastN(channelId, limit = RAW_LIMIT_DEFAULT) {
  const [rows] = await pool.execute(
    `SELECT id, channel_id, created_at, author, role, type, content
       FROM history
      WHERE channel_id = ?
   ORDER BY id DESC
      LIMIT ?`,
    [channelId, Number(limit)]
  );
  // return ascending
  return [...rows].reverse();
}

/** Fetch time-window messages in channel, ASC */
async function fetchByTime(channelId, fromIso, toIso, limit = RAW_LIMIT_DEFAULT) {
  const params = [channelId];
  let where = "channel_id = ?";
  if (fromIso) { where += " AND created_at >= ?"; params.push(fromIso); }
  if (toIso)   { where += " AND created_at <= ?"; params.push(toIso); }

  where += " ORDER BY id ASC";
  const q = `SELECT id, channel_id, created_at, author, role, type, content
               FROM history
              WHERE ${where}
              LIMIT ?`;

  params.push(Number(limit));
  const [rows] = await pool.execute(q, params);
  return rows;
}

/** Fetch direct keyword matches (ids only) within channel, limited */
async function fetchMatchIds(channelId, terms, limit = MATCH_LIMIT) {
  const { sql, params } = buildAndLike(terms);
  const [ids] = await pool.execute(
    `SELECT id
       FROM history
      WHERE channel_id = ?
        AND ${sql}
   ORDER BY id ASC
      LIMIT ?`,
    [channelId, ...params, Number(limit)]
  );
  return ids.map(r => r.id);
}

/** Fetch a channel-safe context window (±before/after) around a given id */
async function fetchContextWindow(channelId, matchId, before = CTX_BEFORE, after = CTX_AFTER) {
  const [prev] = await pool.execute(
    `SELECT id, channel_id, created_at, author, role, type, content
       FROM history
      WHERE channel_id = ? AND id < ?
   ORDER BY id DESC
      LIMIT ?`,
    [channelId, matchId, Number(before)]
  );
  const [center] = await pool.execute(
    `SELECT id, channel_id, created_at, author, role, type, content
       FROM history
      WHERE channel_id = ? AND id = ?`,
    [channelId, matchId]
  );
  const [next] = await pool.execute(
    `SELECT id, channel_id, created_at, author, role, type, content
       FROM history
      WHERE channel_id = ? AND id > ?
   ORDER BY id ASC
      LIMIT ?`,
    [channelId, matchId, Number(after)]
  );

  const prevAsc = [...prev].reverse();
  return [...prevAsc, ...center, ...next];
}

/** Merge multiple windows, dedupe by id, return ASC */
function mergeDedupSort(windows) {
  const map = new Map();
  for (const arr of windows) {
    for (const r of arr) map.set(r.id, r);
  }
  return [...map.values()].sort((a, b) => a.id - b.id);
}

/** Convert rows to a simple text block suitable for direct LLM context */
function rowsToPassthroughText(rows) {
  return rows.map(r => {
    const ts = r.created_at ? new Date(r.created_at).toISOString() : "";
    const speaker = r.author || r.role || "unknown";
    return `[${ts}] ${speaker}: ${String(r.content || "").trim()}`;
  }).join("\n");
}

// ---------- Main tool ----------
async function getHistory(toolFunction) {
  try {
    const args = parseArgs(toolFunction);
    const mode = String(args.mode || "raw").toLowerCase();
    const channelId = String(args.channel_id || "").trim();
    const userId = String(args.user_id || "").trim(); // optional, for auditing or prompts
    const query = String(args.query || "").trim();

    if (!channelId) {
      return JSON.stringify({ error: "HISTORY_INPUT — Missing 'channel_id'." });
    }

    // --- RAW MODE: preserve current behavior exactly; no AI processing; summaries remain intact ---
    if (mode === "raw") {
      const limit = Number(args.limit || RAW_LIMIT_DEFAULT);
      const timeFrom = args.time_from ? String(args.time_from) : null;
      const timeTo   = args.time_to   ? String(args.time_to)   : null;

      let rows;
      if (timeFrom || timeTo) {
        rows = await fetchByTime(channelId, timeFrom, timeTo, limit);
      } else if (query) {
        const terms = extractTerms(query);
        const { sql, params } = buildAndLike(terms);
        const [out] = await pool.execute(
          `SELECT id, channel_id, created_at, author, role, type, content
             FROM history
            WHERE channel_id = ?
              AND ${sql}
         ORDER BY id ASC
            LIMIT ?`,
          [channelId, ...params, Number(limit)]
        );
        rows = out;
      } else {
        rows = await fetchLastN(channelId, limit);
      }

      // Return EXACT rows array — no wrapper object, no reformatting, no AI.
      return JSON.stringify(rows);
    }

    // --- PASSTHROUGH MODE: still raw DB read, but concatenated into one big text block (no AI) ---
    if (mode === "passthrough") {
      const limit = Number(args.limit || RAW_LIMIT_DEFAULT);
      const timeFrom = args.time_from ? String(args.time_from) : null;
      const timeTo   = args.time_to   ? String(args.time_to)   : null;

      let rows;
      if (timeFrom || timeTo) {
        rows = await fetchByTime(channelId, timeFrom, timeTo, limit);
      } else if (query) {
        const terms = extractTerms(query);
        const { sql, params } = buildAndLike(terms);
        const [out] = await pool.execute(
          `SELECT id, channel_id, created_at, author, role, type, content
             FROM history
            WHERE channel_id = ?
              AND ${sql}
         ORDER BY id ASC
            LIMIT ?`,
          [channelId, ...params, Number(limit)]
        );
        rows = out;
      } else {
        rows = await fetchLastN(channelId, limit);
      }

      // Single text block for direct LLM context injection
      const text = rowsToPassthroughText(rows);
      return text || "";
    }

    // --- QA MODE: keyword matches + channel-safe context windows ±10; merged; answered via GPT-4.1 ---
    if (mode === "qa") {
      const q = query || String(args.question || "").trim();
      if (!q) {
        return JSON.stringify({ error: "HISTORY_QA_INPUT — Missing 'query' for QA mode." });
      }

      const terms = extractTerms(q);
      if (!terms.length) {
        return JSON.stringify({ error: "HISTORY_QA_INPUT — Query has no usable terms." });
      }

      // 1) Find match ids in this channel
      const matchIds = await fetchMatchIds(channelId, terms, MATCH_LIMIT);
      if (!matchIds.length) {
        return JSON.stringify({ result: "Keine Treffer im Verlauf gefunden." });
      }

      // 2) For each id, fetch window ±10 in same channel
      const windows = [];
      for (const id of matchIds) {
        const windowRows = await fetchContextWindow(channelId, id, CTX_BEFORE, CTX_AFTER);
        windows.push(windowRows);
      }

      // 3) Merge, dedupe, ASC
      const contextRows = mergeDedupSort(windows);

      // 4) Build digest and ask the model
      const digest = rowsToPassthroughText(contextRows);
      const ctx = new Context();

      await ctx.add(
        "system",
        "history_qa",
        [
          "You are given a set of chat log excerpts from a single Discord channel.",
          "Answer the user's question ONLY based on these excerpts.",
          "If the answer is not derivable, say so explicitly.",
          "Be concise and quote exact wording if the user asked for quotes.",
          "Language: respond in the user's language; prefer German if unsure.",
        ].join(" ")
      );

      await ctx.add("user", "question", q);
      await ctx.add("user", "context", digest);

      const out = await getAI(ctx, QA_TOKENS, QA_MODEL);
      const result = (out || "").trim() || "Keine Antwort ableitbar.";

      return JSON.stringify({ result });
    }

    return JSON.stringify({ error: `HISTORY_MODE — Unknown mode: ${mode}` });
  } catch (err) {
    await reportError(err, null, "HISTORY_UNHANDLED", "ERROR");
    return JSON.stringify({ error: `HISTORY_UNHANDLED — ${err?.message || "Unexpected failure"}` });
  }
}

module.exports = { getHistory };

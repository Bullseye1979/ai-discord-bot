// history.js — smart v5.0
// - findTimeframes(keywords[], window=30): AND-match on content, expand ±window rows per hit, merge overlaps, return JSON windows [{start,end}].
// - getHistory({start?,end?,user_prompt,model?,max_tokens?}): Load ALL rows for channel in timeframe (or full channel if none),
//   build one big digest (no chunking), single LLM pass with user_prompt. No LIMIT. Very verbose logging.
//
// Notes:
// * This relies on sufficiently high OpenAI timeout in aiService.js (OPENAI_TIMEOUT_MS). Set e.g. 180000 or 240000.
// * Queries are scoped to the channel_id resolved from ctx/runtime/args.

const mysql = require("mysql2/promise");
const { getAI } = require("./aiService.js");
const Context = require("./context.js");

let pool = null;

/** Create singleton MySQL pool */
async function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 5,
      charset: "utf8mb4",
      dateStrings: true
    });
    console.log("[history][pool] { created: true, dateStrings: true }");
  }
  return pool;
}

/* ----------------------------- helpers ----------------------------- */

function resolveChannelId(ctxOrUndefined, runtime, args) {
  return (
    (ctxOrUndefined && ctxOrUndefined.channelId && String(ctxOrUndefined.channelId).trim()) ||
    (runtime && runtime.channel_id && String(runtime.channel_id).trim()) ||
    (args && args.channel_id && String(args.channel_id).trim()) ||
    ""
  );
}

function normalizeKeywords(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const s = String(raw || "").trim().toLowerCase();
    if (s.length >= 2 && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function rowsToText(rows) {
  return (rows || [])
    .map((r) => {
      const ts = r.timestamp ? new Date(String(r.timestamp).replace(" ", "T") + "Z").toISOString() : "";
      const who = (r.sender || r.role || "unknown").trim();
      const role = (r.role || "").trim().toLowerCase();
      const prefix = role && who && role !== who ? `${role}/${who}` : who || role || "unknown";
      const content = String(r.content || "").replace(/\r?\n/g, " ").trim();
      return `[${ts}] ${prefix}: ${content}`;
    })
    .join("\n");
}

function dedupRows(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const key = `${r.id}::${r.timestamp}::${r.role || ""}::${r.sender || ""}::${r.content || ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

/** Merge overlapping [{start,end}] intervals (ISO strings). */
function mergeIntervals(intervals) {
  if (!Array.isArray(intervals) || intervals.length === 0) return [];
  const toMs = (s) => (s ? Date.parse(s) : 0);
  const arr = intervals
    .map((it) => ({ startMs: toMs(it.start), endMs: toMs(it.end) }))
    .filter((it) => Number.isFinite(it.startMs) && Number.isFinite(it.endMs) && it.startMs <= it.endMs)
    .sort((a, b) => a.startMs - b.startMs);

  const merged = [];
  for (const it of arr) {
    if (!merged.length) { merged.push({ ...it }); continue; }
    const last = merged[merged.length - 1];
    if (it.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, it.endMs);
    } else {
      merged.push({ ...it });
    }
  }
  return merged.map((m) => ({
    start: new Date(m.startMs).toISOString(),
    end: new Date(m.endMs).toISOString()
  }));
}

/* ----------------------------- findTimeframes ----------------------------- */

async function findTimeframes(toolFunction, ctxOrUndefined, _getAIResponse, runtime) {
  const reqId = Math.random().toString(36).slice(2, 8);
  try {
    const args = typeof toolFunction.arguments === "string"
      ? JSON.parse(toolFunction.arguments || "{}")
      : (toolFunction.arguments || {});
    const channelId = resolveChannelId(ctxOrUndefined, runtime, args);
    const keywords = normalizeKeywords(args.keywords || []);
    const window = Number.isFinite(Number(args.window)) ? Math.max(0, Math.floor(Number(args.window))) : 30;

    console.log(`[history][findTimeframes#${reqId}:args]`, JSON.stringify({ channelId, keywords, window }, null, 2));

    if (!channelId) return JSON.stringify({ error: "channel_id missing" });
    if (!keywords.length) return JSON.stringify({ error: "no keywords" });

    const db = await getPool();

    // 1) Matches (AND-LIKE on content), no LIMIT
    const clause = keywords.map(() => "content LIKE ?").join(" AND ");
    const likes = keywords.map((k) => `%${k}%`);
    const matchSQL =
      "SELECT id, timestamp FROM context_log WHERE channel_id = ? AND " + clause + " ORDER BY id ASC";
    const matchVals = [channelId, ...likes];

    console.log(`[history][findTimeframes#${reqId}:matchSQL]`, JSON.stringify({ sql: matchSQL, values: matchVals }, null, 2));
    const t0 = Date.now();
    const [hits] = await db.execute(matchSQL, matchVals);
    const dur = `${Date.now() - t0}ms`;
    console.log(`[history][findTimeframes#${reqId}:matchRES]`, JSON.stringify({ rowCount: hits.length, dur }, null, 2));

    if (!hits.length) {
      return JSON.stringify({ frames: [], rowCount: 0, note: "no matches" });
    }

    // 2) Expand each hit to ±window rows (same channel) → get boundary timestamps
    async function expandHitById(hit) {
      const prevSQL =
        "SELECT timestamp FROM context_log WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?";
      const nextSQL =
        "SELECT timestamp FROM context_log WHERE channel_id = ? AND id > ? ORDER BY id ASC LIMIT ?";
      const [prev] = await db.execute(prevSQL, [channelId, hit.id, window]);
      const [next] = await db.execute(nextSQL, [channelId, hit.id, window]);

      const startTs = prev.length ? prev[prev.length - 1].timestamp : hit.timestamp;
      const endTs = next.length ? next[next.length - 1].timestamp : hit.timestamp;

      const startISO = new Date(String(startTs).replace(" ", "T") + "Z").toISOString();
      const endISO = new Date(String(endTs).replace(" ", "T") + "Z").toISOString();
      return { start: startISO, end: endISO };
    }

    const intervals = [];
    for (const h of hits) {
      // eslint-disable-next-line no-await-in-loop
      const frame = await expandHitById(h);
      intervals.push(frame);
    }

    // 3) Merge overlaps
    const frames = mergeIntervals(intervals);

    console.log(`[history][findTimeframes#${reqId}:frames]`, JSON.stringify({ framesCount: frames.length, sample: frames.slice(0, 3) }, null, 2));
    return JSON.stringify({ frames, rowCount: hits.length });
  } catch (err) {
    console.error(`[history][findTimeframes#${reqId}:ERROR]`, err?.message || err);
    return JSON.stringify({ error: String(err?.message || err) });
  }
}

/* ----------------------------- getHistory (timeframe summarization) ----------------------------- */

async function getHistory(toolFunction, ctxOrUndefined, _getAIResponse, runtime) {
  const reqId = Math.random().toString(36).slice(2, 8);
  try {
    const args = typeof toolFunction.arguments === "string"
      ? JSON.parse(toolFunction.arguments || "{}")
      : (toolFunction.arguments || {});
    const channelId = resolveChannelId(ctxOrUndefined, runtime, args);
    const start = args.start ? String(args.start).trim() : null;
    const end = args.end ? String(args.end).trim() : null;
    const userPrompt = String(args.user_prompt || "").trim();
    const model = String(args.model || process.env.TIMEFRAME_MODEL || "gpt-4.1");
    const maxTokens = Number.isFinite(Number(args.max_tokens))
      ? Math.max(256, Math.floor(Number(args.max_tokens)))
      : Math.max(256, Math.floor(Number(process.env.TIMEFRAME_TOKENS || 1400)));

    console.log(`[history][getHistory#${reqId}:args]`, JSON.stringify({ channelId, start, end, userPromptLen: userPrompt.length, model, maxTokens }, null, 2));

    if (!channelId) return "ERROR: channel_id missing";
    if (!userPrompt) return "ERROR: user_prompt is required";

    const db = await getPool();

    // Build SQL (NO LIMIT), channel-scoped, ORDER BY id ASC for stability
    const where = ["channel_id = ?"];
    const vals = [channelId];
    if (start) { where.push("timestamp >= ?"); vals.push(start); }
    if (end)   { where.push("timestamp <= ?"); vals.push(end); }

    const sql =
      `SELECT id, timestamp, role, sender, content
         FROM context_log
        WHERE ${where.join(" AND ")}
     ORDER BY id ASC`;
    console.log(`[history][getHistory#${reqId}:sql]`, JSON.stringify({ sql, values: vals }, null, 2));

    const t0 = Date.now();
    const [rows] = await db.execute(sql, vals);
    const dur = `${Date.now() - t0}ms`;

    console.log(`[history][getHistory#${reqId}:res]`, JSON.stringify({
      rowCount: rows.length,
      dur,
      firstRow: rows[0] ? { id: rows[0].id, ts: rows[0].timestamp, role: rows[0].role, sender: rows[0].sender } : null,
      lastRow: rows.length ? { id: rows[rows.length - 1].id, ts: rows[rows.length - 1].timestamp, role: rows[rows.length - 1].role, sender: rows[rows.length - 1].sender } : null
    }, null, 2));

    if (!rows.length) return "No data in timeframe / history.";

    // Build one big digest (NO chunking)
    const digest = rowsToText(rows);
    console.log(`[history][getHistory#${reqId}:digest]`, JSON.stringify({ chars: digest.length }, null, 2));

    // Single-pass LLM
    const ctx = new Context("", "", [], {}, null, { skipInitialSummaries: true, persistToDB: false });

    await ctx.add("system", "history_timeframe",
      [
        "You are given the chat logs from a single Discord channel for a specific timeframe (or full history).",
        "Follow the user instruction precisely. Keep factual details, decisions, tasks (owner & deadline), questions, numbers, URLs/IDs, code refs, and errors.",
        "Preserve chronology when relevant. If information is insufficient, say so briefly.",
        "Respond in the user's language; prefer German if unsure."
      ].join(" ")
    );
    await ctx.add("user", "instruction", userPrompt);
    await ctx.add("user", "logs", digest);

    const out = await getAI(ctx, maxTokens, model);
    const result = (out || "").trim() || "Keine Antwort ableitbar.";
    console.log(`[history][getHistory#${reqId}:done]`, JSON.stringify({ outLen: result.length }, null, 2));
    return result;
  } catch (err) {
    console.error(`[history][getHistory#${reqId}:ERROR]`, err?.message || err);
    return `ERROR: ${err?.message || String(err)}`;
  }
}

module.exports = { findTimeframes, getHistory };

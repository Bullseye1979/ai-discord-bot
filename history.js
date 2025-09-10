// history.js — search windows + timeframe analyzer v6.0
// - getTimeframes({ keywords[], around_seconds?, merge_gap_seconds?, match_limit?, log_hint? })
//   RETURNS a JSON string: { windows: [{ start, end, hits, sample }], total_matches }
// - getHistory({ user_prompt, start?, end?, chunk_rows?, chunk_chars?, model?, max_tokens?, log_hint? })
//   Loads the timeframe (or FULL history if start/end omitted) in pages, locally chunks (rows/chars),
//   runs user_prompt per chunk via LLM, and merges partials to ONE final answer.
//
// ENV (optional):
//   TIMEFRAME_CHUNK_CHARS (default 15000)
//   TIMEFRAME_CHUNK_ROWS  (default 500)
//   TIMEFRAME_MODEL       (default "gpt-4.1")
//   TIMEFRAME_TOKENS      (default 1200)

const mysql = require("mysql2/promise");
const crypto = require("crypto");
const { getAI } = require("./aiService.js");
const Context = require("./context.js");

let pool = null;

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
    console.log(`[history][pool] {"created":true,"dateStrings":true}`);
  }
  return pool;
}

/* ----------------------------- Helpers ----------------------------- */

function txid() {
  return crypto.randomBytes(3).toString("hex");
}

/** Resolve channel id: ctx → runtime → args. */
function resolveChannelId(ctxOrUndefined, runtime, args) {
  return (
    (ctxOrUndefined && ctxOrUndefined.channelId && String(ctxOrUndefined.channelId).trim()) ||
    (runtime && runtime.channel_id && String(runtime.channel_id).trim()) ||
    (args && args.channel_id && String(args.channel_id).trim()) ||
    ""
  );
}

/** Normalize keywords (AND semantics) */
function normalizeKeywords(arr) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map((s) => String(s || "").trim().toLowerCase()).filter((s) => s.length >= 2))];
}

function toIso(tsStr) {
  // DB liefert "YYYY-MM-DD HH:MM:SS" (UTC oder Server-Zeit). Wir behandeln es wie UTC.
  return new Date(tsStr.replace(" ", "T") + "Z").toISOString();
}

/** rows → single digest text */
function rowsToText(rows) {
  return (rows || [])
    .map((r) => {
      const ts = r.timestamp ? toIso(r.timestamp) : "";
      const who = (r.sender || r.role || "unknown").trim();
      const role = (r.role || "").trim().toLowerCase();
      const prefix = role && who && role !== who ? `${role}/${who}` : who || role || "unknown";
      const content = String(r.content || "").replace(/\r?\n/g, " ").trim();
      return `[${ts}] ${prefix}: ${content}`;
    })
    .join("\n");
}

/** Dedup rows by a composite key */
function dedupRows(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const key = `${r.timestamp}::${r.role || ""}::${r.sender || ""}::${r.content || ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

/* ----------------------------- getTimeframes ----------------------------- */

async function getTimeframes(toolFunction, ctxOrUndefined, _getAIResponse, runtime) {
  const tag = `getTimeframes#${txid()}`;
  try {
    const args = typeof toolFunction.arguments === "string"
      ? JSON.parse(toolFunction.arguments || "{}")
      : (toolFunction.arguments || {});

    const channelId = resolveChannelId(ctxOrUndefined, runtime, args);
    const keywords  = normalizeKeywords(args.keywords || []);
    const aroundSec = Number.isFinite(Number(args.around_seconds)) ? Math.max(1, Math.floor(Number(args.around_seconds))) : 900;  // 15 min
    const mergeGap  = Number.isFinite(Number(args.merge_gap_seconds)) ? Math.max(0, Math.floor(Number(args.merge_gap_seconds))) : 300; // 5 min
    const matchLim  = Number.isFinite(Number(args.match_limit)) ? Math.max(1, Math.floor(Number(args.match_limit))) : 100;

    if (!channelId) return JSON.stringify({ error: "channel_id missing" });
    if (!keywords.length) return JSON.stringify({ error: "No keywords provided" });

    console.log(`[timeframes][${tag}:args]`, JSON.stringify({
      log_hint: args.log_hint || "",
      channelId, keywords, aroundSec, mergeGap, matchLim
    }, null, 2));

    const db = await getPool();

    const clause = keywords.map(() => "content LIKE ?").join(" AND ");
    const likeVals = keywords.map(k => `%${k}%`);
    const sql = `SELECT id, timestamp, role, sender, content
                   FROM context_log
                  WHERE channel_id = ? AND ${clause}
              ORDER BY timestamp ASC
                  LIMIT ?`;
    const t0 = Date.now();
    const [rows] = await db.execute(sql, [channelId, ...likeVals, matchLim]);
    const dur = `${Date.now() - t0}ms`;

    console.log(`[timeframes][${tag}:matchSQL]`, JSON.stringify({
      sql: sql.replace(/\s+/g, " "),
      values: [channelId, ...likeVals, matchLim]
    }, null, 2));
    console.log(`[timeframes][${tag}:matchRES]`, JSON.stringify({
      rowCount: rows?.length || 0,
      dur,
      first: rows?.[0] ? { id: rows[0].id, timestamp: rows[0].timestamp } : {},
      last: rows?.length ? { id: rows[rows.length - 1].id, timestamp: rows[rows.length - 1].timestamp } : {}
    }, null, 2));

    if (!rows || rows.length === 0) {
      return JSON.stringify({ windows: [], total_matches: 0 });
    }

    // Baue Roh-Fenster
    const secs = (s) => s * 1000;
    const rawWindows = rows.map(r => {
      const t = new Date(r.timestamp.replace(" ", "T") + "Z").getTime();
      return {
        startMs: t - secs(aroundSec),
        endMs:   t + secs(aroundSec),
        hits:    1,
        sample:  `[${toIso(r.timestamp)}] ${(r.sender || r.role || "unknown")}: ${String(r.content || "").slice(0, 140)}`
      };
    });

    // Mergen (überlappende/nahe Fenster)
    rawWindows.sort((a, b) => a.startMs - b.startMs);
    const merged = [];
    for (const w of rawWindows) {
      if (!merged.length) { merged.push({ ...w }); continue; }
      const last = merged[merged.length - 1];
      if (w.startMs <= last.endMs + secs(mergeGap)) {
        last.endMs = Math.max(last.endMs, w.endMs);
        last.hits += w.hits;
        // sample behalten (erstes)
      } else {
        merged.push({ ...w });
      }
    }

    const out = {
      windows: merged.map(w => ({
        start: new Date(w.startMs).toISOString(),
        end:   new Date(w.endMs).toISOString(),
        hits:  w.hits,
        sample: w.sample
      })),
      total_matches: rows.length
    };

    console.log(`[timeframes][${tag}:windows]`, JSON.stringify({
      merged: out.windows.length,
      total_matches: out.total_matches
    }, null, 2));

    return JSON.stringify(out);
  } catch (err) {
    console.error(`[timeframes][${tag}:ERROR]`, err?.stack || err?.message || String(err));
    return JSON.stringify({ error: err?.message || String(err) });
  }
}

/* ----------------------------- getHistory (timeframe/full + chunking) ----------------------------- */

async function iterateHistoryChunks(db, channelId, start, end, CHUNK_ROWS, CHUNK_CHARS, tag) {
  let lastId = 0;
  const pageSize = Math.max(2000, CHUNK_ROWS * 2);

  const whereParts = ["channel_id = ?", "id > ?"];
  const binds = [channelId, lastId];
  if (start) { whereParts.push("timestamp >= ?"); binds.push(start); }
  if (end)   { whereParts.push("timestamp <= ?"); binds.push(end); }

  const chunkTexts = [];
  let bufferRows = [];
  let bufferChars = 0;

  function flush() {
    if (!bufferRows.length) return;
    const text = rowsToText(bufferRows);
    chunkTexts.push(text);
    bufferRows = [];
    bufferChars = 0;
  }

  while (true) {
    const sql = `SELECT id, timestamp, role, sender, content
                   FROM context_log
                  WHERE ${whereParts.join(" AND ")}
               ORDER BY id ASC
                  LIMIT ?`;
    const t0 = Date.now();
    const [rows] = await db.execute(sql, [...binds, pageSize]);
    const dur = `${Date.now() - t0}ms`;

    console.log(`[history][${tag}:page]`, JSON.stringify({
      sql: sql.replace(/\s+/g, " "),
      binds: [...binds, pageSize],
      fetched: rows?.length || 0,
      dur
    }, null, 2));

    if (!rows || rows.length === 0) {
      flush();
      break;
    }

    for (const r of rows) {
      const line = rowsToText([r]);
      const len = line.length + 1;
      const overflow = (bufferChars + len > CHUNK_CHARS) || (bufferRows.length + 1 > CHUNK_ROWS);
      if (overflow) flush();
      bufferRows.push(r);
      bufferChars += len;
      lastId = r.id;
    }
    binds[1] = lastId;

    if (rows.length < pageSize) {
      flush();
      break;
    }
  }

  console.log(`[history][${tag}:chunks]`, JSON.stringify({
    chunks: chunkTexts.length,
    firstLen: chunkTexts[0]?.length || 0,
    lastLen: chunkTexts.length ? chunkTexts[chunkTexts.length - 1].length : 0
  }, null, 2));

  return chunkTexts;
}

async function runPromptOnChunks(chunks, userPrompt, model, maxTokens, tag) {
  const partials = [];
  for (let i = 0; i < chunks.length; i++) {
    const ctx = new Context("", "", [], {}, null, { skipInitialSummaries: true, persistToDB: false });
    await ctx.add("system", "history_slice", [
      "You will analyze a slice of chat history from a single Discord channel.",
      "Follow the user's instruction precisely on THIS slice only.",
      "Keep facts, decisions, tasks (owner/deadline), numbers, URLs/IDs, and quotes when relevant.",
      "Be concise but complete for this slice."
    ].join(" "));
    await ctx.add("user", "instruction", userPrompt);
    await ctx.add("user", "slice", chunks[i]);

    const t0 = Date.now();
    const out = await getAI(ctx, maxTokens, model);
    const dur = `${Date.now() - t0}ms`;
    const text = (out || "").trim();
    partials.push(text);

    console.log(`[history][${tag}:chunk#${i + 1}]`, JSON.stringify({
      lenIn: chunks[i]?.length || 0,
      lenOut: text.length,
      dur
    }, null, 2));
  }
  return partials;
}

async function mergePartials(partials, userPrompt, model, maxTokens, tag) {
  if (partials.length === 1) return partials[0] || "No result.";
  const ctx = new Context("", "", [], {}, null, { skipInitialSummaries: true, persistToDB: false });
  await ctx.add("system", "merge", [
    "You will merge multiple partial analyses of different slices of a chat history (all from the same channel).",
    "Combine them into ONE coherent answer that fulfills the original user_prompt.",
    "Remove duplicates, keep exact facts/timestamps/actors where present, and preserve chronology where it matters."
  ].join(" "));
  await ctx.add("user", "user_prompt", userPrompt);
  await ctx.add("user", "partials", partials.join("\n\n--- PARTIAL ---\n\n"));

  const t0 = Date.now();
  const final = await getAI(ctx, Math.max(maxTokens, 1400), model);
  const dur = `${Date.now() - t0}ms`;
  console.log(`[history][${tag}:merge]`, JSON.stringify({ dur, len: (final || "").length }, null, 2));
  return (final || "").trim() || "No merged result.";
}

async function getHistory(toolFunction, ctxOrUndefined, _getAIResponse, runtime) {
  const tag = `getHistory#${txid()}`;
  try {
    const args = typeof toolFunction.arguments === "string"
      ? JSON.parse(toolFunction.arguments || "{}")
      : (toolFunction.arguments || {});

    const channelId  = resolveChannelId(ctxOrUndefined, runtime, args);
    const userPrompt = String(args.user_prompt || "").trim();
    const start      = args.start ? String(args.start).trim() : null;
    const end        = args.end   ? String(args.end).trim()   : null;

    const CHUNK_ROWS = Number.isFinite(Number(args.chunk_rows))
      ? Math.max(50, Math.floor(Number(args.chunk_rows)))
      : Math.max(50, Math.floor(Number(process.env.TIMEFRAME_CHUNK_ROWS || 500)));

    const CHUNK_CHARS = Number.isFinite(Number(args.chunk_chars))
      ? Math.max(1000, Math.floor(Number(args.chunk_chars)))
      : Math.max(1000, Math.floor(Number(process.env.TIMEFRAME_CHUNK_CHARS || 15000)));

    const MODEL = String(args.model || process.env.TIMEFRAME_MODEL || "gpt-4.1");
    const MAX_TOKENS = Number.isFinite(Number(args.max_tokens))
      ? Math.max(256, Math.floor(Number(args.max_tokens)))
      : Math.max(256, Math.floor(Number(process.env.TIMEFRAME_TOKENS || 1200)));

    if (!channelId) return "ERROR: channel_id missing (context/runtime/args).";
    if (!userPrompt) return "ERROR: user_prompt is required.";

    console.log(`[history][${tag}:args]`, JSON.stringify({
      log_hint: args.log_hint || "",
      channelId, start, end, CHUNK_ROWS, CHUNK_CHARS, MODEL, MAX_TOKENS
    }, null, 2));

    const db = await getPool();

    // 1) Zeitfenster laden (oder gesamte History)
    const chunks = await iterateHistoryChunks(db, channelId, start, end, CHUNK_ROWS, CHUNK_CHARS, tag);
    if (!chunks.length) {
      console.log(`[history][${tag}:empty] {"info":"No data in range/full history."}`);
      return "No data.";
    }

    // 2) Prompt pro Chunk
    const partials = await runPromptOnChunks(chunks, userPrompt, MODEL, MAX_TOKENS, tag);

    // 3) Merge → final
    const final = await mergePartials(partials, userPrompt, MODEL, MAX_TOKENS, tag);
    return final || "No result.";
  } catch (err) {
    console.error(`[history][${tag}:ERROR]`, err?.stack || err?.message || String(err));
    return `ERROR: ${err?.message || String(err)}`;
  }
}

module.exports = { getTimeframes, getHistory };

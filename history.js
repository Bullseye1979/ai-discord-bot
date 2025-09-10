// history.js — v4.1 (verbose logging + getHistory fallback hint)
// READ-ONLY MySQL SELECT over channel history (context_log).
// - getHistory(keywords, window, match_limit): AND-Matches in context_log + ±window im selben Channel -> Digest mit Timestamps (Text).
//     * Wenn keine Treffer → "NO_MATCHES: getTimeframe is recommended for broad summaries."
// - getTimeframe({start,end,user_prompt}) ODER gesamte History ohne start/end:
//     * lädt Datensätze (id-aufsteigend, kanalgefiltert) in Seiten,
//     * Notfall-Chunking per char/row-Caps,
//     * führt user_prompt pro Chunk via GPT-4.1 (oder args.model) aus,
//     * merged mehrere Chunk-Ergebnisse zu einem Final-Result.
// - Keine Summary-Sonderfälle, keine Schreibzugriffe.
//
// ENV (optional):
//   TIMEFRAME_CHUNK_CHARS (default 15000)
//   TIMEFRAME_CHUNK_ROWS  (default 500)
//   TIMEFRAME_MODEL       (default "gpt-4.1")
//   TIMEFRAME_TOKENS      (default 1200)

const mysql = require("mysql2/promise");
const { getAI } = require("./aiService.js");
const Context = require("./context.js");

let pool = null;

/** Returns a singleton MySQL pool (dateStrings=true). */
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
      dateStrings: true,
    });
    console.log('[history][pool]', JSON.stringify({ created: true, dateStrings: true }, null, 2));
  }
  return pool;
}

/* ----------------------------- Shared helpers ----------------------------- */

/** short correlation id for log lines */
function cid() {
  return Math.random().toString(36).slice(2, 8);
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

/** Safe AND tokenization for keywords (min length 2). */
function normalizeKeywords(arr) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map((s) => String(s || "").trim().toLowerCase()).filter((s) => s.length >= 2))];
}

/** Formats rows -> text lines with timestamps. */
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

/** Dedup by (timestamp, role, sender, content). */
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

/* ----------------------------- getHistory (keywords + window) ----------------------------- */

async function getHistory(toolFunction, ctxOrUndefined, _getAIResponse, runtime) {
  const tag = `getHistory#${cid()}`;
  try {
    const args = typeof toolFunction.arguments === "string"
      ? JSON.parse(toolFunction.arguments || "{}")
      : (toolFunction.arguments || {});
    const channelId = resolveChannelId(ctxOrUndefined, runtime, args);
    const keywords = normalizeKeywords(args.keywords || []);
    const window = Number.isFinite(Number(args.window)) ? Math.max(0, Math.floor(Number(args.window))) : 10;
    const matchLimit = Number.isFinite(Number(args.match_limit)) ? Math.max(1, Math.floor(Number(args.match_limit))) : 30;

    console.log(`[history][${tag}:args] ${JSON.stringify({ channelId, keywords, window, matchLimit }, null, 2)}`);

    if (!channelId) return "ERROR: channel_id missing (context/runtime/args).";
    if (!keywords.length) return "NO_KEYWORDS: getTimeframe is recommended for summaries/recaps.";

    const db = await getPool();

    // 1) Treffer via AND-LIKE (einzelne Zeile muss alle Keywords enthalten)
    const clause = keywords.map(() => "content LIKE ?").join(" AND ");
    const likeVals = keywords.map((t) => `%${t}%`);
    const matchSQL =
      "SELECT id, timestamp, role, sender, content " +
      "FROM context_log " +
      "WHERE channel_id = ? AND " + clause + " " +
      "ORDER BY timestamp ASC " +
      "LIMIT ?";
    const matchValues = [channelId, ...likeVals, matchLimit];

    console.log(`[history][${tag}:matchSQL] ${JSON.stringify({ sql: matchSQL, values: matchValues }, null, 2)}`);

    const t0 = Date.now();
    const [matchRows] = await db.execute(matchSQL, matchValues);
    const durMatch = `${Date.now() - t0}ms`;

    const firstPrev = matchRows?.[0] ? {
      id: matchRows[0].id, ts: matchRows[0].timestamp, role: matchRows[0].role, sender: matchRows[0].sender,
      contentPreview: String(matchRows[0].content || "").slice(0, 160)
    } : {};
    const lastPrev = matchRows?.length ? (() => {
      const r = matchRows[matchRows.length - 1];
      return { id: r.id, ts: r.timestamp, role: r.role, sender: r.sender, contentPreview: String(r.content || "").slice(0, 160) };
    })() : {};

    console.log(`[history][${tag}:matchRES] ${JSON.stringify({ rowCount: matchRows.length || 0, dur: durMatch, first: firstPrev, last: lastPrev }, null, 2)}`);

    if (!matchRows || matchRows.length === 0) {
      return "NO_MATCHES: getTimeframe is recommended for broad summaries.";
    }

    // 2) Für jeden Treffer: Fenster ±window (per timestamp, gleicher Kanal)
    async function fetchWindow(ts) {
      const [prev] = await db.execute(
        `SELECT id, timestamp, role, sender, content
           FROM context_log
          WHERE channel_id = ? AND timestamp < ?
       ORDER BY timestamp DESC
          LIMIT ?`,
        [channelId, ts, window]
      );
      const [center] = await db.execute(
        `SELECT id, timestamp, role, sender, content
           FROM context_log
          WHERE channel_id = ? AND timestamp = ?
       ORDER BY timestamp ASC
          LIMIT 1`,
        [channelId, ts]
      );
      const [next] = await db.execute(
        `SELECT id, timestamp, role, sender, content
           FROM context_log
          WHERE channel_id = ? AND timestamp > ?
       ORDER BY timestamp ASC
          LIMIT ?`,
        [channelId, ts, window]
      );
      const prevAsc = [...prev].reverse();
      return [...prevAsc, ...center, ...next];
    }

    const w0 = Date.now();
    const windows = [];
    for (const m of matchRows) {
      // eslint-disable-next-line no-await-in-loop
      const w = await fetchWindow(m.timestamp);
      windows.push(w);
    }
    console.log(`[history][${tag}:windows] ${JSON.stringify({ expanded: windows.length, dur: `${Date.now() - w0}ms` }, null, 2)}`);

    // 3) Merge + dedup + sort
    const merged = dedupRows(windows.flat()).sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0
    );

    const digest = rowsToText(merged);
    const lineCount = digest ? digest.split("\n").filter(Boolean).length : 0;
    console.log(`[history][${tag}:digest] ${JSON.stringify({ lines: lineCount, chars: (digest || "").length }, null, 2)}`);

    // Optionaler Low-yield Hinweis (das ist nur ein Hinweis – wir geben trotzdem das Digest zurück)
    if (lineCount < 5) {
      console.log(`[history][${tag}:hint] LOW_YIELD — model should consider calling getTimeframe for a broader recap.`);
    }

    return digest || "No content.";
  } catch (err) {
    console.error(`[history][${tag}:ERROR]`, err?.message || err);
    return `ERROR: ${err?.message || String(err)}`;
  }
}

/* ----------------------------- getTimeframe (range OR full, with chunking) ----------------------------- */

async function getTimeframe(toolFunction, ctxOrUndefined, _getAIResponse, runtime) {
  const tag = `getTimeframe#${cid()}`;
  try {
    const args = typeof toolFunction.arguments === "string"
      ? JSON.parse(toolFunction.arguments || "{}")
      : (toolFunction.arguments || {});
    const channelId = resolveChannelId(ctxOrUndefined, runtime, args);
    let userPrompt = String(args.user_prompt || "").trim();

    if (!channelId) return "ERROR: channel_id missing (context/runtime/args).";
    if (!userPrompt) userPrompt = "Summarize key events, decisions, tasks (with owners/deadlines), and outcomes.";

    // optional timeframe (full history if omitted)
    const start = args.start ? String(args.start).trim() : null;
    const end   = args.end ? String(args.end).trim() : null;

    const CHUNK_CHARS = Number.isFinite(Number(args.chunk_chars))
      ? Math.max(1000, Math.floor(Number(args.chunk_chars)))
      : Math.max(1000, Math.floor(Number(process.env.TIMEFRAME_CHUNK_CHARS || 15000)));

    const CHUNK_ROWS = Number.isFinite(Number(args.chunk_rows))
      ? Math.max(50, Math.floor(Number(args.chunk_rows)))
      : Math.max(50, Math.floor(Number(process.env.TIMEFRAME_CHUNK_ROWS || 500)));

    const MODEL = String(args.model || process.env.TIMEFRAME_MODEL || "gpt-4.1");
    const MAX_TOKENS = Number.isFinite(Number(args.max_tokens))
      ? Math.max(256, Math.floor(Number(args.max_tokens)))
      : Math.max(256, Math.floor(Number(process.env.TIMEFRAME_TOKENS || 1200)));

    console.log(`[history][${tag}:args] ${JSON.stringify({ channelId, start, end, CHUNK_CHARS, CHUNK_ROWS, MODEL, MAX_TOKENS }, null, 2)}`);

    const db = await getPool();

    // Page-by-id iterieren, um riesige Offsets zu vermeiden
    let lastId = 0;
    const pageSize = Math.max(2000, CHUNK_ROWS * 2); // mehr als ein Chunk, wir chunking'en lokal

    const chunkTexts = [];
    let bufferRows = [];
    let bufferChars = 0;

    function flushBufferToChunks() {
      if (bufferRows.length === 0) return;
      const text = rowsToText(bufferRows);
      chunkTexts.push(text);
      console.log(`[history][${tag}:flush] ${JSON.stringify({ chunkIndex: chunkTexts.length - 1, rows: bufferRows.length, chars: text.length }, null, 2)}`);
      bufferRows = [];
      bufferChars = 0;
    }

    // Grund-SQL: kanal + id>lastId, optional timeframe, ORDER BY id ASC LIMIT ?
    const whereParts = ["channel_id = ?","id > ?"];
    const bindBase = [channelId, lastId];
    if (start) { whereParts.push("timestamp >= ?"); bindBase.push(start); }
    if (end)   { whereParts.push("timestamp <= ?"); bindBase.push(end); }

    // Schleife über alle Seiten
    let totalRows = 0;
    while (true) {
      const sql =
        `SELECT id, timestamp, role, sender, content
           FROM context_log
          WHERE ${whereParts.join(" AND ")}
       ORDER BY id ASC
          LIMIT ?`;
      const values = [...bindBase, pageSize];

      console.log(`[history][${tag}:pageSQL] ${JSON.stringify({ sql, values }, null, 2)}`);
      const tPage = Date.now();
      const [rows] = await db.execute(sql, values);
      console.log(`[history][${tag}:pageRES] ${JSON.stringify({ fetched: rows?.length || 0, dur: `${Date.now() - tPage}ms` }, null, 2)}`);

      if (!rows || rows.length === 0) {
        flushBufferToChunks();
        break;
      }

      // packe rows in Buffer bis Cap erreicht
      for (const r of rows) {
        const line = rowsToText([r]);
        const lineLen = line.length + 1;
        const wouldOverflow = (bufferChars + lineLen > CHUNK_CHARS) || (bufferRows.length + 1 > CHUNK_ROWS);

        if (wouldOverflow) {
          flushBufferToChunks();
        }
        bufferRows.push(r);
        bufferChars += lineLen;
        lastId = r.id;
        totalRows++;
      }

      // update bindBase[1] (id > lastId) for next loop
      bindBase[1] = lastId;

      // falls Seiten kleiner als pageSize -> fertig
      if (rows.length < pageSize) {
        flushBufferToChunks();
        break;
      }
    }

    console.log(`[history][${tag}:collect] ${JSON.stringify({ chunks: chunkTexts.length, totalRows }, null, 2)}`);

    if (chunkTexts.length === 0) return "No data in the selected range / history.";

    // Pro Chunk user_prompt ausführen → partial results
    const partials = [];
    for (let i = 0; i < chunkTexts.length; i++) {
      const ctx = new Context("", "", [], {}, null, { skipInitialSummaries: true, persistToDB: false });

      await ctx.add(
        "system",
        "timeframe_chunk",
        [
          "You will analyze a slice of chat history from a single Discord channel.",
          "The user will provide an instruction (user_prompt).",
          "Follow it precisely on THIS slice only and keep facts, decisions, tasks (owner/deadline), numbers, URLs/IDs, and quotes when relevant.",
          "Be concise but complete for this slice.",
        ].join(" ")
      );
      await ctx.add("user", "instruction", userPrompt);
      await ctx.add("user", "slice", chunkTexts[i]);

      const tChunk = Date.now();
      const out = await getAI(ctx, MAX_TOKENS, MODEL);
      const trimmed = (out || "").trim();
      console.log(`[history][${tag}:chunkAI] ${JSON.stringify({ chunk: i + 1, of: chunkTexts.length, tokens: MAX_TOKENS, dur: `${Date.now() - tChunk}ms`, empty: trimmed.length === 0 }, null, 2)}`);
      partials.push(trimmed);
    }

    // Wenn nur ein Chunk → direkt zurück
    if (partials.length === 1) {
      console.log(`[history][${tag}:final] single-partial`);
      return partials[0] || "No result.";
    }

    // Mehrere Chunks → zusammenführen
    const mergeCtx = new Context("", "", [], {}, null, { skipInitialSummaries: true, persistToDB: false });
    await mergeCtx.add(
      "system",
      "timeframe_merge",
      [
        "You will merge multiple partial analyses of different slices of a chat history (all from the same channel).",
        "Combine them into ONE coherent answer that fulfills the original user_prompt.",
        "Remove duplicates, keep exact facts/timestamps/actors where present, and preserve chronology when it matters.",
      ].join(" ")
    );
    await mergeCtx.add("user", "user_prompt", userPrompt);
    await mergeCtx.add("user", "partials", partials.join("\n\n--- PARTIAL ---\n\n"));

    const tMerge = Date.now();
    const final = await getAI(mergeCtx, Math.max(MAX_TOKENS, 1400), MODEL);
    console.log(`[history][${tag}:mergeAI] ${JSON.stringify({ parts: partials.length, dur: `${Date.now() - tMerge}ms` }, null, 2)}`);
    return (final || "").trim() || "No merged result.";
  } catch (err) {
    console.error(`[history][${tag}:ERROR]`, err?.message || err);
    return `ERROR: ${err?.message || String(err)}`;
  }
}

module.exports = { getHistory, getTimeframe };

// history.js — v4.0
// READ-ONLY MySQL SELECT over channel history (context_log).
// - getHistory(keywords, window, match_limit): AND-Matches in context_log + ±window im selben Channel -> Digest mit Timestamps (Text).
// - getTimeframe({start,end,user_prompt}) ODER gesamte History ohne start/end:
//     * lädt Datensätze (id-aufsteigend, kanalgefiltert) in Seiten,
//     * Notfall-Chunking per char/row-Caps,
//     * führt user_prompt pro Chunk via GPT-4.1 aus,
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
  }
  return pool;
}

/* ----------------------------- Shared helpers ----------------------------- */

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
      const ts = r.timestamp ? new Date(r.timestamp.replace(" ", "T") + "Z").toISOString() : "";
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
  try {
    const args = typeof toolFunction.arguments === "string"
      ? JSON.parse(toolFunction.arguments || "{}")
      : (toolFunction.arguments || {});
    const channelId = resolveChannelId(ctxOrUndefined, runtime, args);
    if (!channelId) return "ERROR: channel_id missing (context/runtime/args).";

    const keywords = normalizeKeywords(args.keywords || []);
    if (!keywords.length) return "No keywords provided (min length 2 per token).";

    const window = Number.isFinite(Number(args.window)) ? Math.max(0, Math.floor(Number(args.window))) : 10;
    const matchLimit = Number.isFinite(Number(args.match_limit)) ? Math.max(1, Math.floor(Number(args.match_limit))) : 30;

    const db = await getPool();

    // 1) finde Treffer-Zeiten via AND-LIKE auf content
    const clause = keywords.map(() => "content LIKE ?").join(" AND ");
    const likeVals = keywords.map((t) => `%${t}%`);
    const [matchRows] = await db.execute(
      `SELECT id, timestamp, role, sender, content
         FROM context_log
        WHERE channel_id = ? AND ${clause}
     ORDER BY timestamp ASC
        LIMIT ?`,
      [channelId, ...likeVals, matchLimit]
    );
    if (!matchRows || matchRows.length === 0) return "No matches found.";

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

    const windows = [];
    for (const m of matchRows) {
      // eslint-disable-next-line no-await-in-loop
      const w = await fetchWindow(m.timestamp);
      windows.push(w);
    }

    // 3) mergen + deduplizieren + sortieren
    const merged = dedupRows(windows.flat()).sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0
    );

    // 4) Digest (mit Timestamps) für die KI-Weiterverwendung
    const digest = rowsToText(merged);
    return digest || "No content.";
  } catch (err) {
    console.error("[getHistory] ERROR:", err?.message || err);
    return `ERROR: ${err?.message || String(err)}`;
  }
}

/* ----------------------------- getTimeframe (range OR full, with chunking) ----------------------------- */

async function getTimeframe(toolFunction, ctxOrUndefined, _getAIResponse, runtime) {
  try {
    const args = typeof toolFunction.arguments === "string"
      ? JSON.parse(toolFunction.arguments || "{}")
      : (toolFunction.arguments || {});
    const channelId = resolveChannelId(ctxOrUndefined, runtime, args);
    if (!channelId) return "ERROR: channel_id missing (context/runtime/args).";

    const userPrompt = String(args.user_prompt || "").trim();
    if (!userPrompt) return "ERROR: user_prompt is required.";

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
      bufferRows = [];
      bufferChars = 0;
    }

    // Grund-SQL: kanal + id>lastId, optional timeframe, ORDER BY id ASC LIMIT ?
    const whereParts = ["channel_id = ?","id > ?"];
    const bindBase = [channelId, lastId];
    if (start) { whereParts.push("timestamp >= ?"); bindBase.push(start); }
    if (end)   { whereParts.push("timestamp <= ?"); bindBase.push(end); }

    // Schleife über alle Seiten
    while (true) {
      const [rows] = await db.execute(
        `SELECT id, timestamp, role, sender, content
           FROM context_log
          WHERE ${whereParts.join(" AND ")}
       ORDER BY id ASC
          LIMIT ?`,
        [...bindBase, pageSize]
      );

      if (!rows || rows.length === 0) {
        // restlicher Buffer als letzter Chunk
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
      }

      // update bindBase[1] (id > lastId) for next loop
      bindBase[1] = lastId;

      // falls Seiten kleiner als pageSize -> fertig
      if (rows.length < pageSize) {
        flushBufferToChunks();
        break;
      }
    }

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

      // use getAI directly (history tools shouldn't mutate global context)
      const out = await getAI(ctx, MAX_TOKENS, MODEL);
      partials.push((out || "").trim());
    }

    // Wenn nur ein Chunk → direkt zurück
    if (partials.length === 1) {
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

    const final = await getAI(mergeCtx, Math.max(MAX_TOKENS, 1400), MODEL);
    return (final || "").trim() || "No merged result.";
  } catch (err) {
    console.error("[getTimeframe] ERROR:", err?.message || err);
    return `ERROR: ${err?.message || String(err)}`;
  }
}

module.exports = { getHistory, getTimeframe };

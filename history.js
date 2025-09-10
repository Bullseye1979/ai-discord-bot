// history.js — unified v5.0
// READ-ONLY MySQL SELECT over channel history (context_log).
// - getHistory({ user_prompt, keywords?, window?, match_limit?, start?, end?, chunk_rows?, chunk_chars?, model?, max_tokens?, log_hint? })
//   * Wenn timeframe (start/end) fehlt → gesamte History mit Chunking verarbeiten
//   * Keywords (AND) → Treffer + ±window Rows (selber Kanal) → "keyword digest"
//   * Timeframe/Full-History → Seitenweise lesen, lokal chunken, pro Chunk user_prompt ausführen → partials → Merge
//   * Wenn beides vorhanden → beide Stränge zusammenführen (final merge)
// - Kein Schreiben; nur SELECT (dateStrings=true)
// - Umfangreiche Logs mit txId

const mysql = require("mysql2/promise");
const crypto = require("crypto");
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

/* ----------------------------- Core SELECTs ----------------------------- */

async function selectKeywordWindows(db, channelId, keywords, window, matchLimit, tag) {
  const clause = keywords.map(() => "content LIKE ?").join(" AND ");
  const likeVals = keywords.map((t) => `%${t}%`);

  const sql = `SELECT id, timestamp, role, sender, content
                 FROM context_log
                WHERE channel_id = ? AND ${clause}
            ORDER BY timestamp ASC
                LIMIT ?`;

  console.log(`[history][${tag}:matchSQL]`, JSON.stringify({ sql: sql.replace(/\s+/g, " "), values: [channelId, ...likeVals, matchLimit] }, null, 2));
  const t0 = Date.now();
  const [matchRows] = await db.execute(sql, [channelId, ...likeVals, matchLimit]);
  const dur = `${Date.now() - t0}ms`;
  console.log(`[history][${tag}:matchRES]`, JSON.stringify({
    rowCount: matchRows?.length || 0,
    dur,
    first: JSON.stringify(matchRows?.[0] || {}),
    last: JSON.stringify(matchRows && matchRows.length ? matchRows[matchRows.length - 1] : {})
  }, null, 2));

  if (!matchRows || matchRows.length === 0) return "";

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

  const merged = dedupRows(windows.flat()).sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0
  );

  const digest = rowsToText(merged);
  console.log(`[history][${tag}:keywordDigest]`, JSON.stringify({
    lines: digest ? digest.split("\n").length : 0,
    chars: digest.length
  }, null, 2));
  return digest || "";
}

async function iterateHistoryChunks(db, channelId, start, end, CHUNK_ROWS, CHUNK_CHARS, tag) {
  // page-by-id (no huge offsets)
  let lastId = 0;
  const pageSize = Math.max(2000, CHUNK_ROWS * 2);

  const whereParts = ["channel_id = ?", "id > ?"];
  const binds = [channelId, lastId];
  if (start) { whereParts.push("timestamp >= ?"); binds.push(start); }
  if (end)   { whereParts.push("timestamp <= ?"); binds.push(end); }

  const chunkTexts = [];
  let bufferRows = [];
  let bufferChars = 0;

  function flushBuffer() {
    if (bufferRows.length === 0) return;
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
      flushBuffer();
      break;
    }

    for (const r of rows) {
      const line = rowsToText([r]);
      const lineLen = line.length + 1;
      const wouldOverflow = (bufferChars + lineLen > CHUNK_CHARS) || (bufferRows.length + 1 > CHUNK_ROWS);
      if (wouldOverflow) flushBuffer();
      bufferRows.push(r);
      bufferChars += lineLen;
      lastId = r.id;
    }

    binds[1] = lastId; // id > lastId for next page

    if (rows.length < pageSize) {
      flushBuffer();
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

/* ----------------------------- LLM steps ----------------------------- */

async function runPromptOnChunks(chunks, userPrompt, model, maxTokens, tag, focusHintsText = "") {
  const partials = [];

  for (let i = 0; i < chunks.length; i++) {
    const ctx = new Context("", "", [], {}, null, { skipInitialSummaries: true, persistToDB: false });

    const sysLines = [
      "You will analyze a slice of chat history from a single Discord channel.",
      "Follow the user's instruction precisely on THIS slice only.",
      "Keep facts, decisions, tasks (owner/deadline), numbers, URLs/IDs, quotes when relevant.",
      "Be concise but complete for this slice."
    ];
    if (focusHintsText) {
      sysLines.push("Focus hints (optional): prioritize events related to the provided focused excerpts.");
    }

    await ctx.add("system", "history_slice", sysLines.join(" "));
    if (focusHintsText) await ctx.add("user", "focus_hints", focusHintsText);
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

async function mergePartialsAndKeyword(partials, keywordSummary, userPrompt, model, maxTokens, tag) {
  // Wenn es nur eine Quelle gibt, direkt zurück
  if ((!keywordSummary || !keywordSummary.trim()) && partials.length === 1) {
    return partials[0] || "No result.";
  }
  if ((!keywordSummary || !keywordSummary.trim()) && partials.length > 1) {
    const ctx = new Context("", "", [], {}, null, { skipInitialSummaries: true, persistToDB: false });
    await ctx.add("system", "merge", [
      "You will merge multiple partial analyses of different slices of a chat history (all from the same channel).",
      "Combine them into ONE coherent answer that fulfills the original user_prompt.",
      "Remove duplicates, keep exact facts/timestamps/actors where present, and preserve chronology when it matters."
    ].join(" "));
    await ctx.add("user", "user_prompt", userPrompt);
    await ctx.add("user", "partials", partials.join("\n\n--- PARTIAL ---\n\n"));
    const t0 = Date.now();
    const final = await getAI(ctx, Math.max(maxTokens, 1400), model);
    const dur = `${Date.now() - t0}ms`;
    console.log(`[history][${tag}:mergePartials]`, JSON.stringify({ dur, len: (final || "").length }, null, 2));
    return (final || "").trim() || "No merged result.";
  }

  // Keyword-Zusammenfassung vorhanden → finaler Merge beider Stränge
  const ctx = new Context("", "", [], {}, null, { skipInitialSummaries: true, persistToDB: false });
  await ctx.add("system", "merge_all", [
    "You will merge:",
    " (1) an aggregated summary synthesized from full/timeframed history chunks, and",
    " (2) a focused summary built from keyword-centered windows.",
    "Output ONE coherent answer that fulfills the user_prompt.",
    "Remove duplicates, keep exact facts/timestamps/actors where present, and preserve chronology where relevant."
  ].join(" "));
  await ctx.add("user", "user_prompt", userPrompt);
  if (partials.length === 1) {
    await ctx.add("user", "history_synthesis", partials[0]);
  } else {
    await ctx.add("user", "history_synthesis", partials.join("\n\n--- PARTIAL ---\n\n"));
  }
  await ctx.add("user", "keyword_focus", keywordSummary);

  const t0 = Date.now();
  const final = await getAI(ctx, Math.max(maxTokens, 1600), model);
  const dur = `${Date.now() - t0}ms`;
  console.log(`[history][${tag}:mergeFinal]`, JSON.stringify({ dur, len: (final || "").length }, null, 2));
  return (final || "").trim() || "No merged result.";
}

/* ----------------------------- Unified Tool ----------------------------- */

async function getHistory(toolFunction, ctxOrUndefined, _getAIResponse, runtime) {
  const tag = `getHistory#${txid()}`;
  try {
    const args = typeof toolFunction.arguments === "string"
      ? JSON.parse(toolFunction.arguments || "{}")
      : (toolFunction.arguments || {});
    const channelId = resolveChannelId(ctxOrUndefined, runtime, args);
    const userPrompt = String(args.user_prompt || "").trim();

    const rawKeywords = Array.isArray(args.keywords) ? args.keywords : [];
    const keywords = normalizeKeywords(rawKeywords);
    const window = Number.isFinite(Number(args.window)) ? Math.max(0, Math.floor(Number(args.window))) : 10;
    const matchLimit = Number.isFinite(Number(args.match_limit)) ? Math.max(1, Math.floor(Number(args.match_limit))) : 30;

    const start = args.start ? String(args.start).trim() : null;
    const end   = args.end ? String(args.end).trim() : null;

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
      channelId, keywords, window, matchLimit, start, end,
      CHUNK_ROWS, CHUNK_CHARS, MODEL, MAX_TOKENS
    }, null, 2));

    const db = await getPool();

    // --- (A) Keyword-digest (optional) ---
    let keywordDigest = "";
    if (keywords.length) {
      keywordDigest = await selectKeywordWindows(db, channelId, keywords, window, matchLimit, tag);
    } else {
      console.log(`[history][${tag}:keywords] {"skip":"no keywords"}`);
    }

    // --- (B) Timeframe / Full history chunks ---
    // Falls kein timeframe angegeben → gesamte History chunken
    const chunks = await iterateHistoryChunks(db, channelId, start, end, CHUNK_ROWS, CHUNK_CHARS, tag);
    if (!chunks.length) {
      console.log(`[history][${tag}:noChunks] {"info":"No rows in the selected range/history."}`);
      // Wenn dennoch ein keywordDigest existiert, antworte zumindest darauf:
      if (keywordDigest) {
        console.log(`[history][${tag}:fallbackKeywordOnly] {"info":"Only keyword digest available"}`);
        const partials = await runPromptOnChunks([keywordDigest], userPrompt, MODEL, MAX_TOKENS, `${tag}:kwOnly`, "");
        return partials[0] || "No result.";
      }
      return "No data.";
    }

    // --- (C) Pro Chunk prompten (optional mit Focus-Hinweisen aus KeywordDigest, aber nur als Hint) ---
    const focusHints = keywordDigest ? keywordDigest.slice(0, 3000) : "";
    const partials = await runPromptOnChunks(chunks, userPrompt, MODEL, MAX_TOKENS, tag, focusHints);

    // --- (D) Optional: KeywordDigest separat verdichten ---
    let keywordSummary = "";
    if (keywordDigest) {
      const ctx = new Context("", "", [], {}, null, { skipInitialSummaries: true, persistToDB: false });
      await ctx.add("system", "keyword_focus", [
        "You will summarize focused excerpts around keyword matches.",
        "Produce a concise synthesis relevant to the user's instruction."
      ].join(" "));
      await ctx.add("user", "user_prompt", userPrompt);
      await ctx.add("user", "focused_excerpts", keywordDigest);
      const t0 = Date.now();
      const out = await getAI(ctx, Math.max(MAX_TOKENS, 800), MODEL);
      const dur = `${Date.now() - t0}ms`;
      keywordSummary = (out || "").trim();
      console.log(`[history][${tag}:keywordSummary]`, JSON.stringify({ lenIn: keywordDigest.length, lenOut: keywordSummary.length, dur }, null, 2));
    } else {
      console.log(`[history][${tag}:keywordSummary] {"skip":"no digest"}`);
    }

    // --- (E) Final Merge ---
    const final = await mergePartialsAndKeyword(partials, keywordSummary, userPrompt, MODEL, MAX_TOKENS, tag);
    return final || "No result.";
  } catch (err) {
    console.error(`[history][${tag}:ERROR]`, err?.stack || err?.message || String(err));
    return `ERROR: ${err?.message || String(err)}`;
  }
}

module.exports = { getHistory };

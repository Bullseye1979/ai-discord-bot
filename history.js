// history.js — v5.0 (Timeframe search + Single-pass History)
// READ-ONLY MySQL SELECT over channel history (context_log).
// - getTimeframe({keywords, window, merge_gap_minutes, match_limit?}):
//     * findet Treffer (AND über keywords) ohne hartes LIMIT (optional match_limit),
//     * expandiert je Treffer um ±window Nachrichten,
//     * mergen benachbarter/überlappender Zeitfenster (merge_gap_minutes),
//     * Rückgabe: JSON { timeframes: [{start,end,count}], total_matches }.
// - getHistory({user_prompt, start?, end?, keywords?}):
//     * lädt ALLE passenden Zeilen (id-aufsteigend, kanalspezifisch) seitenweise,
//     * baut EINEN großen Digest-Text mit Timestamps,
//     * führt GENAU EINEN KI-Pass (gpt-4.1 default) mit user_prompt aus,
//     * Rückgabe: nur das LLM-Ergebnis.
//
// ENV (optional):
//   HISTORY_PAGE_SIZE   default 5000  (DB-Pagegröße, nur DB-Pagination; kein Chunking zum LLM)
//   HISTORY_MODEL       default "gpt-4.1"
//   HISTORY_TOKENS      default 1600
//
// Ausführliche Konsolen-Logs (SQL, Bindings, Laufzeiten, Seiten, Größen, Previews).

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
    console.log("[history][pool] { created: true, dateStrings: true }");
  }
  return pool;
}

/* ----------------------------- Helpers ----------------------------- */

function nowIso() { return new Date().toISOString(); }

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
function rowToLine(r) {
  const ts = r.timestamp ? new Date(r.timestamp.replace(" ", "T") + "Z").toISOString() : "";
  const who = (r.sender || r.role || "unknown").trim();
  const role = (r.role || "").trim().toLowerCase();
  const prefix = role && who && role !== who ? `${role}/${who}` : who || role || "unknown";
  const content = String(r.content || "").replace(/\r?\n/g, " ").trim();
  return `[${ts}] ${prefix}: ${content}`;
}
function rowsToText(rows) {
  return (rows || []).map(rowToLine).join("\n");
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

/* ----------------------------- getTimeframe ----------------------------- */

async function getTimeframe(toolFunction, ctxOrUndefined, _getAIResponse, runtime) {
  const tid = Math.random().toString(36).slice(2, 8);
  const t0 = Date.now();
  try {
    const args = typeof toolFunction.arguments === "string"
      ? JSON.parse(toolFunction.arguments || "{}")
      : (toolFunction.arguments || {});
    const channelId = resolveChannelId(ctxOrUndefined, runtime, args);
    const keywords = normalizeKeywords(args.keywords || []);
    const window = Number.isFinite(Number(args.window)) ? Math.max(0, Math.floor(Number(args.window))) : 10;
    const mergeGapMin = Number.isFinite(Number(args.merge_gap_minutes)) ? Math.max(0, Math.floor(Number(args.merge_gap_minutes))) : 5;
    const matchLimit = Number.isFinite(Number(args.match_limit)) ? Math.max(1, Math.floor(Number(args.match_limit))) : null;

    if (!channelId) return JSON.stringify({ error: "channel_id missing (context/runtime/args)." });
    if (!keywords.length) return JSON.stringify({ error: "keywords missing/too short." });

    console.log(`[history][getTimeframe#${tid}:args]`, JSON.stringify({ channelId, keywords, window, mergeGapMin, matchLimit }, null, 2));

    const db = await getPool();

    // 1) Treffer (AND über keywords), optionales LIMIT nur wenn matchLimit gesetzt
    const clause = keywords.map(() => "content LIKE ?").join(" AND ");
    const likeVals = keywords.map((t) => `%${t}%`);
    const baseSql = `SELECT id, timestamp FROM context_log WHERE channel_id = ? AND ${clause} ORDER BY timestamp ASC`;
    const sql = matchLimit ? `${baseSql} LIMIT ${Number(matchLimit)}` : baseSql;
    const vals = [channelId, ...likeVals];

    console.log(`[history][getTimeframe#${tid}:matchSQL]`, JSON.stringify({ sql, values: vals }, null, 2));

    const m0 = Date.now();
    const [matches] = await db.execute(sql, vals);
    const mDur = Date.now() - m0;

    console.log(`[history][getTimeframe#${tid}:matchRES]`, JSON.stringify({
      total: matches?.length || 0,
      dur: `${mDur}ms`,
      first: matches?.[0] || null,
      last: matches?.[matches.length - 1] || null
    }, null, 2));

    if (!matches || matches.length === 0) {
      return JSON.stringify({ timeframes: [], total_matches: 0 });
    }

    // 2) Für jeden Match: ±window Nachrichten bestimmen -> Start/End (per timestamp/kanal)
    async function windowBounds(ts) {
      const [prev] = await db.execute(
        `SELECT timestamp FROM context_log WHERE channel_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?`,
        [channelId, ts, window]
      );
      const [next] = await db.execute(
        `SELECT timestamp FROM context_log WHERE channel_id = ? AND timestamp > ? ORDER BY timestamp ASC LIMIT ?`,
        [channelId, ts, window]
      );
      const start = prev.length ? prev[prev.length - 1].timestamp : ts;
      const end = next.length ? next[next.length - 1].timestamp : ts;
      return { start, end };
    }

    const rawRanges = [];
    for (const m of matches) {
      // eslint-disable-next-line no-await-in-loop
      const w = await windowBounds(m.timestamp);
      rawRanges.push(w);
    }

    // 3) Mergen überlappender/naher Fenster
    const gapMs = mergeGapMin * 60 * 1000;
    const toMs = (t) => new Date(t.replace(" ", "T") + "Z").getTime();

    rawRanges.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    const merged = [];
    for (const r of rawRanges) {
      if (!merged.length) { merged.push({ ...r }); continue; }
      const last = merged[merged.length - 1];
      if (toMs(r.start) <= toMs(last.end) + gapMs) {
        if (toMs(r.end) > toMs(last.end)) last.end = r.end;
      } else {
        merged.push({ ...r });
      }
    }

    // 4) Optional: count der Rows pro Range (nützlich als Relevanz)
    for (const rng of merged) {
      const [cntRows] = await db.execute(
        `SELECT COUNT(*) AS c FROM context_log WHERE channel_id = ? AND timestamp >= ? AND timestamp <= ?`,
        [channelId, rng.start, rng.end]
      );
      rng.count = Number(cntRows?.[0]?.c || 0);
    }

    const took = Date.now() - t0;
    console.log(`[history][getTimeframe#${tid}:result]`, JSON.stringify({
      timeframes: merged,
      total_matches: matches.length,
      dur: `${took}ms`
    }, null, 2));

    return JSON.stringify({ timeframes: merged, total_matches: matches.length });
  } catch (err) {
    console.error(`[history][getTimeframe#${tid}:ERROR]`, err?.message || err);
    return JSON.stringify({ error: err?.message || String(err) });
  }
}

/* ----------------------------- getHistory (single-pass, no chunking) ----------------------------- */

async function getHistory(toolFunction, ctxOrUndefined, _getAIResponse, runtime) {
  const tid = Math.random().toString(36).slice(2, 8);
  const t0 = Date.now();
  try {
    const args = typeof toolFunction.arguments === "string"
      ? JSON.parse(toolFunction.arguments || "{}")
      : (toolFunction.arguments || {});
    const channelId = resolveChannelId(ctxOrUndefined, runtime, args);
    const userPrompt = String(args.user_prompt || "").trim();
    const start = args.start ? String(args.start).trim() : null;
    const end   = args.end ? String(args.end).trim() : null;
    const keywords = normalizeKeywords(args.keywords || []);

    const PAGE = Number.isFinite(Number(process.env.HISTORY_PAGE_SIZE))
      ? Math.max(1000, Math.floor(Number(process.env.HISTORY_PAGE_SIZE)))
      : 5000;

    const MODEL = String(args.model || process.env.HISTORY_MODEL || "gpt-4.1");
    const MAX_TOKENS = Number.isFinite(Number(args.max_tokens || process.env.HISTORY_TOKENS))
      ? Math.max(256, Math.floor(Number(args.max_tokens || process.env.HISTORY_TOKENS)))
      : 1600;

    if (!channelId) return "ERROR: channel_id missing (context/runtime/args).";
    if (!userPrompt) return "ERROR: user_prompt is required.";

    console.log(`[history][getHistory#${tid}:args]`, JSON.stringify({ channelId, start, end, keywords, PAGE, MODEL, MAX_TOKENS }, null, 2));

    const db = await getPool();

    // WHERE dynamisch bauen (kein LIMIT). Wir paginieren nur intern per id > lastId.
    const whereParts = ["channel_id = ?", "id > ?"];
    const bindsBase = [channelId, 0];
    if (start) { whereParts.push("timestamp >= ?"); bindsBase.push(start); }
    if (end)   { whereParts.push("timestamp <= ?"); bindsBase.push(end); }
    if (keywords.length) {
      for (let i = 0; i < keywords.length; i++) whereParts.push("content LIKE ?");
    }

    const likeVals = keywords.map((k) => `%${k}%`);
    let lastId = 0;
    let totalRows = 0;
    let pages = 0;
    const previewFirst = [];
    let lastRow = null;

    let digest = "";
    while (true) {
      const sql =
        `SELECT id, timestamp, role, sender, content
           FROM context_log
          WHERE ${whereParts.join(" AND ")}
       ORDER BY id ASC
          LIMIT ?`;

      const values = [...bindsBase.slice(0, 2), ...(bindsBase.slice(2) || []), ...likeVals, PAGE];

      // vor Page: id > lastId einsetzen
      values[1] = lastId;

      const q0 = Date.now();
      const [rows] = await db.execute(sql, values);
      const qDur = Date.now() - q0;
      pages++;

      console.log(`[history][getHistory#${tid}:page]`, JSON.stringify({
        page: pages,
        sql,
        valuesPreview: values.map(v => (typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "…" : v)),
        rowCount: rows?.length || 0,
        dur: `${qDur}ms`
      }, null, 2));

      if (!rows || rows.length === 0) break;

      if (totalRows === 0 && rows.length) {
        previewFirst.push(rows[0]);
      }

      // Digest anhängen (kein LLM-Chunking — EIN Pass später)
      digest += rowsToText(rows) + "\n";

      totalRows += rows.length;
      lastRow = rows[rows.length - 1];
      lastId = lastRow.id;

      if (rows.length < PAGE) break; // letzte Seite erreicht
    }

    console.log(`[history][getHistory#${tid}:digest]`, JSON.stringify({
      totalRows,
      pages,
      chars: digest.length,
      firstRow: previewFirst[0] || null,
      lastRow: lastRow || null
    }, null, 2));

    if (!digest.trim()) {
      return "No data in the selected range / history.";
    }

    // EIN LLM-PASS über den gesamten Digest
    const ctx = new Context("", "", [], {}, null, { skipInitialSummaries: true, persistToDB: false });

    await ctx.add(
      "system",
      "history_single_pass",
      [
        "You are given the full (possibly filtered) chat history from a single Discord channel as plain text lines with ISO timestamps.",
        "Follow the user's instruction exactly and base your answer ONLY on the provided history.",
        "Preserve chronology where relevant; keep precise facts, numbers, owners/deadlines, and quotes when asked.",
        "Answer in the user's language (German if unclear)."
      ].join(" ")
    );

    await ctx.add("user", "instruction", userPrompt);
    await ctx.add("user", "history", digest);

    const a0 = Date.now();
    const out = await getAI(ctx, MAX_TOKENS, MODEL);
    const aDur = Date.now() - a0;

    console.log(`[history][getHistory#${tid}:ai]`, JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      dur: `${aDur}ms`,
      outPreview: typeof out === "string" ? out.slice(0, 500) : String(out || "").slice(0, 500)
    }, null, 2));

    return (out || "").trim() || "No result.";
  } catch (err) {
    console.error(`[history][getHistory#${tid}:ERROR]`, err?.message || err);
    return `ERROR: ${err?.message || String(err)}`;
  } finally {
    const took = Date.now() - t0;
    console.log(`[history][getHistory#${tid}:done]`, JSON.stringify({ took: `${took}ms`, at: nowIso() }, null, 2));
  }
}

module.exports = { getTimeframe, getHistory };

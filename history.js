// history.js — focused v5.3
// - getInformation({ keywords[], window=10 }):
//     OR-match on content for THIS channel; take the 30 newest hits (by id desc),
//     for each hit include N rows before and after (same channel), deduplicate,
//     return a flat, id-ascending list of { sender, timestamp(ISO), content }.
// - getHistory({ frames?=[{start,end}], start?, end?, user_prompt, model?, max_tokens? }):
//     Single-pass LLM over the selected rows (multi-frame or single range or full channel).
//
// Notes:
// * Ensure high enough OpenAI timeout in aiService.js (e.g., OPENAI_TIMEOUT_MS=180000).
// * All queries are scoped to the channel_id resolved from ctx/runtime/args.

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

function toISO(ts) {
  return ts ? new Date(String(ts).replace(" ", "T") + "Z").toISOString() : "";
}

function rowsToText(rows) {
  return (rows || [])
    .map((r) => {
      const ts = r.timestamp ? toISO(r.timestamp) : "";
      const who = (r.sender || r.role || "unknown").trim();
      const role = (r.role || "").trim().toLowerCase();
      const prefix = role && who && role !== who ? `${role}/${who}` : who || role || "unknown";
      const content = String(r.content || "").replace(/\r?\n/g, " ").trim();
      return `[${ts}] ${prefix}: ${content}`;
    })
    .join("\n");
}

/* ----------------------------- getInformation ----------------------------- */
/**
 * Args:
 *  - keywords: string[]  (OR-Suche)
 *  - window?:  number    (N vor/nach — default 10)
 *  - channel_id?: string (wird sonst aus ctx/runtime gezogen)
 *
 * Returns JSON string:
 *  {
 *    data: [{ sender, timestamp, content }],
 *    count: number,
 *    meta: { hits_considered: number, max_hits: 30, window: number }
 *  }
 */
async function getInformation(toolFunction, ctxOrUndefined, _getAIResponse, runtime) {
  const reqId = Math.random().toString(36).slice(2, 8);
  try {
    const args = typeof toolFunction.arguments === "string"
      ? JSON.parse(toolFunction.arguments || "{}")
      : (toolFunction.arguments || {});
    const channelId = resolveChannelId(ctxOrUndefined, runtime, args);
    const keywords = normalizeKeywords(args.keywords || []);
    const windowN = Number.isFinite(Number(args.window)) ? Math.max(0, Math.floor(Number(args.window))) : 10;
    const MAX_HITS = 30; // feste Vorgabe: nur die 30 neuesten Treffer

    console.log(`[history][getInformation#${reqId}:args]`, JSON.stringify({ channelId, keywords, window: windowN }, null, 2));
    if (!channelId) return JSON.stringify({ error: "channel_id missing" });
    if (!keywords.length) return JSON.stringify({ error: "no keywords" });

    const db = await getPool();

    // 1) OR über alle Keywords — neueste zuerst, LIMIT 30
    //    Stelle sicher, dass die Anzahl der Platzhalter exakt den Werten entspricht.
    const clause = "(" + keywords.map(() => "content LIKE ?").join(" OR ") + ")";
    const likes = keywords.map((k) => `%${k}%`);
    const hitSQL = `SELECT id FROM context_log WHERE channel_id = ? AND ${clause} ORDER BY id DESC LIMIT ?`;
    const hitVals = [channelId, ...likes, Number(MAX_HITS)];

    const t0 = Date.now();
    const [hitRows] = await db.execute(hitSQL, hitVals);
    console.log(`[history][getInformation#${reqId}:hits]`, JSON.stringify({ rowCount: hitRows.length, dur: `${Date.now() - t0}ms` }, null, 2));
    if (!hitRows.length) {
      return JSON.stringify({
        data: [],
        count: 0,
        meta: { hits_considered: 0, max_hits: MAX_HITS, window: windowN },
        note: "no matches"
      });
    }

    // 2) Für jeden Hit: N vorher + Hit + N nachher — jeweils nur im selben Channel
    const idSet = new Set();

    async function expandIdsAround(id) {
      const beforeSQL = "SELECT id FROM context_log WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?";
      const afterSQL  = "SELECT id FROM context_log WHERE channel_id = ? AND id > ? ORDER BY id ASC  LIMIT ?";
      const [prevRows] = await db.execute(beforeSQL, [channelId, id, Number(windowN)]);
      const [nextRows] = await db.execute(afterSQL,  [channelId, id, Number(windowN)]);
      for (const r of prevRows) idSet.add(r.id); // prevRows sind DESC, egal – später global sortieren
      idSet.add(id);
      for (const r of nextRows) idSet.add(r.id);
    }

    for (const h of hitRows) {
      // eslint-disable-next-line no-await-in-loop
      await expandIdsAround(h.id);
    }

    const ids = Array.from(idSet);
    if (!ids.length) {
      return JSON.stringify({
        data: [],
        count: 0,
        meta: { hits_considered: hitRows.length, max_hits: MAX_HITS, window: windowN }
      });
    }

    // 3) Alle Zeilen in einem Rutsch laden — baue IN(?,?,...) mit exakt passender Placeholder-Anzahl
    ids.sort((a, b) => a - b); // sortiere IDs aufsteigend, damit Ausgabe chronologisch ist
    const ph = ids.map(() => "?").join(",");
    const loadSQL = `SELECT id, sender, timestamp, content FROM context_log WHERE channel_id = ? AND id IN (${ph})`;
    const loadVals = [channelId, ...ids];
    const [rows] = await db.execute(loadSQL, loadVals);

    // Sortierung nach id ASC (falls DB nicht exakt in IN-Reihenfolge liefert)
    rows.sort((a, b) => (a.id || 0) - (b.id || 0));

    const data = rows.map((r) => ({
      sender: String(r.sender || "").trim(),
      timestamp: toISO(r.timestamp),
      content: String(r.content || "").trim()
    }));

    return JSON.stringify({
      data,
      count: data.length,
      meta: { hits_considered: hitRows.length, max_hits: MAX_HITS, window: windowN }
    });
  } catch (err) {
    console.error(`[history][getInformation#${reqId}:ERROR]`, err?.message || err);
    return JSON.stringify({ error: String(err?.message || err) });
  }
}

/* ----------------------------- getHistory (multi-frame or single range) ----------------------------- */

async function getHistory(toolFunction, ctxOrUndefined, _getAIResponse, runtime) {
  const reqId = Math.random().toString(36).slice(2, 8);
  try {
    const args = typeof toolFunction.arguments === "string"
      ? JSON.parse(toolFunction.arguments || "{}")
      : (toolFunction.arguments || {});
    const channelId = resolveChannelId(ctxOrUndefined, runtime, args);

    const frames = Array.isArray(args.frames) ? args.frames : [];
    const start = args.start ? String(args.start).trim() : null;
    const end   = args.end   ? String(args.end).trim()   : null;

    const userPrompt = String(args.user_prompt || "").trim();
    const model = String(args.model || process.env.TIMEFRAME_MODEL || "gpt-4.1");
    const maxTokens = Number.isFinite(Number(args.max_tokens))
      ? Math.max(256, Math.floor(Number(args.max_tokens)))
      : Math.max(256, Math.floor(Number(process.env.TIMEFRAME_TOKENS || 1400)));

    console.log(
      `[history][getHistory#${reqId}:args]`,
      JSON.stringify({ channelId, framesCount: frames.length, start, end, userPromptLen: userPrompt.length, model, maxTokens }, null, 2)
    );

    if (!channelId) return "ERROR: channel_id missing";
    if (!userPrompt) return "ERROR: user_prompt is required";

    const db = await getPool();
    let rows = [];

    if (frames.length > 0) {
      for (const f of frames) {
        if (!f || !f.start || !f.end) continue;
        const sql =
          `SELECT id, timestamp, role, sender, content
             FROM context_log
            WHERE channel_id = ? AND timestamp >= ? AND timestamp <= ?
         ORDER BY id ASC`;
        const vals = [channelId, f.start, f.end];

        console.log(`[history][getHistory#${reqId}:frameSQL]`, JSON.stringify({ sql, values: vals }, null, 2));
        // eslint-disable-next-line no-await-in-loop
        const t0 = Date.now();
        // eslint-disable-next-line no-await-in-loop
        const [part] = await db.execute(sql, vals);
        const dur = `${Date.now() - t0}ms`;
        console.log(`[history][getHistory#${reqId}:frameRES]`, JSON.stringify({ frame: f, rowCount: part.length, dur }, null, 2));

        rows = rows.concat(part || []);
      }
    } else {
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
      const [all] = await db.execute(sql, vals);
      const dur = `${Date.now() - t0}ms`;
      console.log(
        `[history][getHistory#${reqId}:res]`,
        JSON.stringify({
          rowCount: all.length,
          dur,
          firstRow: all[0] ? { id: all[0].id, ts: all[0].timestamp, role: all[0].role, sender: all[0].sender } : null,
          lastRow: all.length ? { id: all[all.length - 1].id, ts: all[all.length - 1].timestamp, role: all[all.length - 1].role, sender: all[all.length - 1].sender } : null
        }, null, 2)
      );

      rows = all || [];
    }

    if (!rows.length) return "No data in timeframe / history.";

    rows.sort((a, b) => (a.id || 0) - (b.id || 0));

    const digest = rowsToText(rows);
    console.log(`[history][getHistory#${reqId}:digest]`, JSON.stringify({ chars: digest.length }, null, 2));

    const ctx = new Context("", "", [], {}, null, { skipInitialSummaries: true, persistToDB: false });
    await ctx.add("system", "history_timeframe",
      [
        "You are given the chat logs from a single Discord channel for one or multiple timeframes (merged already by the caller).",
        "Follow the user instruction precisely. Keep factual details, decisions, tasks (owner & deadline), questions, numbers, URLs/IDs, code refs, and errors.",
        "Preserve chronology when relevant. If information is insufficient, say so briefly.",
        "Respond in the user's language; prefer English if unsure."
      ].join(" ")
    );
    await ctx.add("user", "instruction", userPrompt);
    await ctx.add("user", "logs", digest);

    const out = await getAI(ctx, maxTokens, model);
    const result = (out || "").trim() || "No answer possible.";
    console.log(`[history][getHistory#${reqId}:done]`, JSON.stringify({ outLen: result.length }, null, 2));
    return result;
  } catch (err) {
    console.error(`[history][getHistory#${reqId}:ERROR]`, err?.message || err);
    return `ERROR: ${err?.message || String(err)}`;
  }
}

module.exports = { getInformation, getHistory };

// history.js — focused v6.1 (K-of-N + Window Relevance + Smart Dump Threshold)
// - getInformation({ keywords[], window=10, max_hits=30, min_match?, candidate_limit? }):
//     1) K-von-N-Match (Score = #Keywords in content) über die *neusten* Kandidaten,
//     2) Filter auf score >= min_match (Default: 2 wenn ≥2 Keywords, sonst 1),
//     3) Window-Relevanz: für jeden Kandidaten ±N Reihen (im selben Channel) einbeziehen,
//        WindowScore = (#distinct Keywords im Fenster) + Bonus (Zeilen mit >=2 Keywords) + kleiner Frequenzbonus,
//     4) Sortierung: WindowScore DESC, dann id DESC; wähle Top max_hits Fenster,
//     5) Flache, deduplizierte Ausgabe aller Zeilen dieser Fenster (id ASC) als {sender,timestamp,content}.
// - getHistory({ frames?=[{start,end}], start?, end?, user_prompt, model?, max_tokens?,
//                dump_threshold_tokens?, max_dump_chars?, return_json? }):
//     Smart: Komprimieren -> Token-Schätzung -> (klein) Dump-Return ODER (groß) LLM über komprimierten Text.
//
// Notes:
// * Stelle sicher, dass in aiService.js ein hohes Timeout gesetzt ist (OPENAI_TIMEOUT_MS ≥ 180000).
// * Alle DB-Queries werden auf den Channel (channel_id) gescoped.
// * Es werden (wenn möglich) sinnvolle Indizes angelegt: (channel_id,id), (channel_id,timestamp), FULLTEXT(content).

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

/** Simple substring check (case-insensitive, keywords already lowercased). */
function contains(textLower, kwLower) {
  return textLower.indexOf(kwLower) !== -1;
}

/** Rough token estimator: ~4 chars per token (conservative). */
function approxTokensFromChars(chars) {
  return Math.ceil(chars / 4);
}

/**
 * Deterministic cheap compression for logs to reduce token cost
 * - Drops trivial noise (very short ack like "ok", "thx", "lol", "+1")
 * - Collapses consecutive messages from the same sender
 * - Elides huge code blocks (```…```) to «code N lines»
 * - Shortens URLs to host/pathname
 * - Keeps light timestamp (MM-DD HH:MM)
 */
function cheapCompressRows(rows) {
  const out = [];
  let lastSender = null;

  const isNoise = (c) => {
    const s = c.trim().toLowerCase();
    return (
      s.length === 0 ||
      s.length <= 2 ||
      s === "ok" ||
      s === "kk" ||
      s === "thx" ||
      s === "thanks" ||
      s === "lol" ||
      s === "+1"
    );
  };

  for (const r of rows) {
    let c = String(r.content || "").trim();
    if (isNoise(c)) continue;

    // Elide very long code blocks
    c = c.replace(/```[\s\S]*?```/g, (m) => {
      const lines = m.split("\n").length;
      return lines > 30 ? `«code ${lines} lines»` : m;
    });

    // URL shortener (host + pathname)
    c = c.replace(/\bhttps?:\/\/[^\s)]+/g, (u) => {
      try {
        const { host, pathname } = new URL(u);
        return `${host}${pathname}`.replace(/\/+$/, "");
      } catch { return u; }
    });

    const sender = String(r.sender || r.role || "unknown").trim();
    const ts = r.timestamp ? r.timestamp.slice(5, 16).replace("T", " ") : ""; // „MM-DD HH:MM“
    const segment = `[${ts}] ${sender}: ${c}`;

    if (sender === lastSender && out.length) {
      out[out.length - 1] += `; ${c}`;
    } else {
      out.push(segment);
      lastSender = sender;
    }
  }
  return out.join("\n");
}

/* ----------------------------- index management ----------------------------- */

/**
 * Ensure helpful indexes exist.
 * - idx_context_channel_id_id (BTREE): (channel_id, id)
 * - idx_context_channel_id_timestamp (BTREE): (channel_id, timestamp)
 * - ft_context_content (FULLTEXT): (content) — optional, best effort
 */
async function ensureIndexes(db) {
  const schema = process.env.DB_NAME;
  const table = "context_log";

  async function hasIndex(indexName) {
    const sql = `
      SELECT 1
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?
      LIMIT 1
    `;
    const [rows] = await db.execute(sql, [schema, table, indexName]);
    return rows && rows.length > 0;
  }

  async function createIndexIfMissing(indexName, createSQL) {
    const exists = await hasIndex(indexName);
    if (exists) return false;
    await db.execute(createSQL);
    console.log(`[history][index] created: ${indexName}`);
    return true;
  }

  try {
    await createIndexIfMissing(
      "idx_context_channel_id_id",
      `CREATE INDEX idx_context_channel_id_id ON ${table} (channel_id, id)`
    );
  } catch (e) {
    console.warn("[history][index] create idx_context_channel_id_id failed:", e.message || e);
  }

  try {
    await createIndexIfMissing(
      "idx_context_channel_id_timestamp",
      `CREATE INDEX idx_context_channel_id_timestamp ON ${table} (channel_id, timestamp)`
    );
  } catch (e) {
    console.warn("[history][index] create idx_context_channel_id_timestamp failed:", e.message || e);
  }

  // FULLTEXT is best-effort (works on InnoDB MySQL >=5.6). Might fail depending on collation/permissions.
  try {
    await createIndexIfMissing(
      "ft_context_content",
      `CREATE FULLTEXT INDEX ft_context_content ON ${table} (content)`
    );
  } catch (e) {
    console.warn("[history][index] create FULLTEXT ft_context_content failed (optional):", e.message || e);
  }
}

/* ----------------------------- getInformation ----------------------------- */
/**
 * Args:
 *  - keywords: string[]        (Suchbegriffe; case-insensitive)
 *  - window?: number           (N vor/nach — default 10)
 *  - max_hits?: number         (Anzahl der Top-Fenster — default 30)
 *  - min_match?: number        (K in K-von-N; default=2 wenn ≥2 Keywords, sonst 1)
 *  - candidate_limit?: number  (#neueste Kandidaten vor Scoring; default = max(3*max_hits, 90))
 *  - channel_id?: string
 *
 * Returns JSON string:
 *  {
 *    data: [{ sender, timestamp, content }],
 *    count,
 *    meta: { ... }
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
    const maxHits = Number.isFinite(Number(args.max_hits)) ? Math.max(1, Math.floor(Number(args.max_hits))) : 30;
    const defaultMinMatch = keywords.length >= 2 ? 2 : 1;
    const minMatch = Number.isFinite(Number(args.min_match))
      ? Math.min(Math.max(1, Math.floor(Number(args.min_match))), Math.max(1, keywords.length || 1))
      : defaultMinMatch;
    const candidateLimit = Number.isFinite(Number(args.candidate_limit))
      ? Math.max(maxHits, Math.floor(Number(args.candidate_limit)))
      : Math.max(maxHits * 3, 90);

    console.log(
      `[history][getInformation#${reqId}:args]`,
      JSON.stringify({ channelId, keywords, window: windowN, maxHits, minMatch, candidateLimit }, null, 2)
    );

    if (!channelId) return JSON.stringify({ error: "channel_id missing" });
    if (!keywords.length) return JSON.stringify({ error: "no keywords" });

    const db = await getPool();
    await ensureIndexes(db);

    // --- 1) Kandidaten: neuste rows im Channel, die mind. eins der Keywords enthalten
    // Score = Summe (content LIKE ?)
    const likes = keywords.map((k) => `%${k}%`);
    const sumExpr = keywords.map(() => "(content LIKE ?)").join(" + ");
    const whereOr = keywords.map(() => "content LIKE ?").join(" OR ");

    // Reihenfolge der Platzhalter: [ ...likes (für sumExpr), channelId, ...likes (für WHERE), minMatch ]
    const candidateSQL = `
      SELECT id, score FROM (
        SELECT id, (${sumExpr}) AS score
        FROM context_log
        WHERE channel_id = ?
          AND (${whereOr})
        ORDER BY id DESC
        LIMIT ${candidateLimit}
      ) AS t
      WHERE score >= ?
      ORDER BY score DESC, id DESC
      LIMIT ${candidateLimit}
    `;
    const candidateVals = [...likes, channelId, ...likes, minMatch];

    const t0 = Date.now();
    const [candidates] = await db.execute(candidateSQL, candidateVals);
    console.log(
      `[history][getInformation#${reqId}:candidates]`,
      JSON.stringify({ candidates_found: candidates.length, dur: `${Date.now() - t0}ms` }, null, 2)
    );
    if (!candidates.length) {
      return JSON.stringify({
        data: [],
        count: 0,
        meta: {
          keywords, min_match: minMatch, window: windowN, max_hits: maxHits, candidate_limit: candidateLimit,
          candidates_found: 0, candidates_after_min_match: 0, selected_windows: 0,
          scoring: "k-of-n + window relevance"
        },
        note: "no matches"
      });
    }

    // --- 2) Window-Relevanz je Kandidat
    const rowCache = new Map(); // id -> {id,sender,timestamp,content}
    const windows = [];         // { anchorId, score, ids:Set<number> }

    async function loadCenterRow(id) {
      const sql = "SELECT id, sender, timestamp, content FROM context_log WHERE channel_id = ? AND id = ? LIMIT 1";
      const [rows] = await db.execute(sql, [channelId, id]);
      return rows && rows[0] ? rows[0] : null;
    }
    async function loadBefore(id, n) {
      const sql = "SELECT id, sender, timestamp, content FROM context_log WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?";
      const [rows] = await db.execute(sql, [channelId, id, n]);
      return rows || [];
    }
    async function loadAfter(id, n) {
      const sql = "SELECT id, sender, timestamp, content FROM context_log WHERE channel_id = ? AND id > ? ORDER BY id ASC LIMIT ?";
      const [rows] = await db.execute(sql, [channelId, id, n]);
      return rows || [];
    }

    const kwLower = keywords.map((k) => String(k || "").toLowerCase());

    function computeWindowScore(rows) {
      const seenKw = new Set();
      let totalMatches = 0;
      let adjacencyCount = 0;

      for (const r of rows) {
        const textLower = String(r.content || "").toLowerCase();
        let perRowDistinct = 0;
        for (const kw of kwLower) {
          if (contains(textLower, kw)) {
            if (!seenKw.has(kw)) seenKw.add(kw);
            totalMatches += 1;
            perRowDistinct += 1;
          }
        }
        if (perRowDistinct >= 2) adjacencyCount += 1;
      }

      const uniqueCount = seenKw.size;
      const freqBonus = Math.max(0, totalMatches - uniqueCount) * 0.05; // 0.05 je Wiederholung
      const adjBonus = Math.min(adjacencyCount * 0.2, 0.6);             // max 0.6 Bonus
      const score = uniqueCount + adjBonus + Math.min(freqBonus, 0.5);  // max +0.5 aus Frequenz
      return score;
    }

    for (const c of candidates) {
      const anchorId = c.id;
      // eslint-disable-next-line no-await-in-loop
      const [prev, center, next] = await Promise.all([
        loadBefore(anchorId, windowN),
        loadCenterRow(anchorId),
        loadAfter(anchorId, windowN)
      ]);

      const prevAsc = [...prev].reverse();
      const winRows = prevAsc.concat(center ? [center] : []).concat(next);

      // Cache rows
      for (const r of winRows) {
        if (r && !rowCache.has(r.id)) rowCache.set(r.id, r);
      }

      const winScore = computeWindowScore(winRows);
      const idSet = new Set(winRows.map((r) => r.id));

      windows.push({ anchorId, score: winScore, ids: idSet });
    }

    // --- 3) Auswahl der Top-Fenster
    windows.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.anchorId - a.anchorId;
    });
    const selected = windows.slice(0, maxHits);

    // --- 4) IDs sammeln & sortieren
    const globalIdSet = new Set();
    for (const w of selected) {
      for (const id of w.ids) globalIdSet.add(id);
    }
    const finalIds = Array.from(globalIdSet).sort((a, b) => a - b);

    // Nachladen falls nötig
    const missing = finalIds.filter((id) => !rowCache.has(id));
    if (missing.length) {
      const qs = missing.map(() => "?").join(",");
      const loadSQL = `SELECT id, sender, timestamp, content FROM context_log WHERE channel_id = ? AND id IN (${qs})`;
      const [rows] = await db.execute(loadSQL, [channelId, ...missing]);
      for (const r of rows || []) if (!rowCache.has(r.id)) rowCache.set(r.id, r);
    }

    const data = finalIds.map((id) => {
      const r = rowCache.get(id) || {};
      return {
        sender: String(r.sender || "").trim(),
        timestamp: toISO(r.timestamp),
        content: String(r.content || "").trim()
      };
    });

    return JSON.stringify({
      data,
      count: data.length,
      meta: {
        keywords,
        min_match: minMatch,
        window: windowN,
        max_hits: maxHits,
        candidate_limit: candidateLimit,
        candidates_found: candidates.length,
        candidates_after_min_match: candidates.length,
        selected_windows: selected.length,
        scoring: "k-of-n + window relevance"
      }
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
      : Math.max(256, Math.floor(Number(process.env.TIMEFRAME_TOKENS || 12000)));

    // Smart dump thresholds
    const dumpThreshold = Number.isFinite(Number(args.dump_threshold_tokens))
      ? Math.max(500, Math.floor(Number(args.dump_threshold_tokens)))
      : Math.max(500, Math.floor(Number(process.env.HISTORY_DUMP_TOKENS || 4000)));

    const maxDumpChars = Number.isFinite(Number(args.max_dump_chars))
      ? Math.max(10_000, Math.floor(Number(args.max_dump_chars)))
      : Math.max(10_000, Math.floor(Number(process.env.HISTORY_MAX_DUMP_CHARS || 200_000)));

    const returnJSON = String(args.return_json || "").toLowerCase() === "true" || args.return_json === true;

    console.log(
      `[history][getHistory#${reqId}:args]`,
      JSON.stringify({ channelId, framesCount: frames.length, start, end, userPromptLen: userPrompt.length, model, maxTokens, dumpThreshold, maxDumpChars, returnJSON }, null, 2)
    );

    if (!channelId) return "ERROR: channel_id missing";
    if (!userPrompt) return "ERROR: user_prompt is required";

    const db = await getPool();
    await ensureIndexes(db);

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

    // New: compress, estimate tokens, choose path
    const cheap = cheapCompressRows(rows);
    const approx = approxTokensFromChars(cheap.length);
    console.log(`[history][getHistory#${reqId}:compress]`, JSON.stringify({ chars: cheap.length, approx_tokens: approx }, null, 2));

    // Small → Dump (no LLM)
    if (approx <= dumpThreshold) {
      let dump = cheap;
      let truncated = false;
      if (dump.length > maxDumpChars) {
        dump = dump.slice(0, maxDumpChars) + "\n…(truncated)…";
        truncated = true;
      }
      if (returnJSON) {
        return JSON.stringify({
          mode: "dump",
          approx_tokens: approx,
          truncated,
          chars: dump.length,
          dump
        });
      }
      return dump;
    }

    // Large → LLM (feed compressed logs)
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
    // IMPORTANT: give the compressed digest (cheaper) instead of raw
    await ctx.add("user", "logs", cheap);

    const out = await getAI(ctx, maxTokens, model);
    const result = (out || "").trim() || "No answer possible.";
    console.log(`[history][getHistory#${reqId}:done]`, JSON.stringify({ outLen: result.length }, null, 2));

    if (returnJSON) {
      return JSON.stringify({
        mode: "llm",
        approx_tokens: approx,
        input_chars: cheap.length,
        output: result
      });
    }

    return result;
  } catch (err) {
    console.error(`[history][getHistory#${reqId}:ERROR]`, err?.message || err);
    return `ERROR: ${err?.message || String(err)}`;
  }
}

module.exports = { getInformation, getHistory };

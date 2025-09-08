// history.js — v3.0 (modes: raw | passthrough | qa)
// READ-ONLY MySQL SELECT over channel history (context_log, summaries).
// - raw:         identisch zum bisherigen Verhalten (structured parts oder legacy SQL),
//                gibt { rowCount, rows } zurück, KEINE KI, Summaries bleiben 1:1 erhalten.
// - passthrough: holt Datensätze wie raw, gibt aber EINEN Textblock zurück (ideal zum direkten Kontext-Dump).
// - qa:          Keyword-Matches in context_log + kanalsicheres Kontextfenster (±10 via timestamp),
//                dedupliziert + per GPT-4.1 beantwortet; Rückgabe: { result }.
//
// Sicherheiten:
// - Structured mode: { select, from, where, bindings } -> finalen SQL sicher bauen.
// - Legacy mode: args.sql -> "SELECT … FROM … [WHERE …]" parsen und sicher neu bauen.
// - channel_id wird AUTOMATISCH aus ctx.channelId (oder runtime.channel_id oder args.channel_id) ermittelt
//   und immer als zusätzlicher Filter injiziert (Order by timestamp wird erzwungen).
// - LIMIT wird eingefügt, falls nicht vorhanden.
// - Konsolen-Logs des finalen SELECT (mit '?') + Werte (gecapped).
//
// Erfordert: mysql2/promise (DB via ENV: DB_HOST, DB_USER, DB_PASSWORD, DB_NAME)
// Optional (nur für qa): ./aiService.js (getAI) und ./context.js (Context)

const mysql = require("mysql2/promise");
const { getAI } = require("./aiService.js");
const Context = require("./context.js");

let pool = null;

/** Returns a singleton MySQL pool. */
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
    });
  }
  return pool;
}

/* ----------------------------- Helpers ----------------------------- */

function stripTrailingSemicolons(sql) {
  return String(sql || "").replace(/;+\s*$/g, "");
}

/** Ensure ORDER BY `timestamp` ASC exists; inject before LIMIT if LIMIT present. */
function ensureOrderByTimestamp(sql) {
  const s = stripTrailingSemicolons(sql);
  if (/\border\s+by\b/i.test(s)) return s;
  if (/\blimit\b/i.test(s)) {
    return s.replace(/\blimit\b/i, "ORDER BY `timestamp` ASC LIMIT");
  }
  return `${s} ORDER BY \`timestamp\` ASC`;
}

/** Compiles :named placeholders into '?', returns { sql, values }.
 *  Adds LIMIT 200 if missing.
 *  IMPORTANT: names must start with [A-Za-z_] to avoid matching time literals like "10:00".
 */
function compileNamed(sql, bindings) {
  const values = [];
  const cleaned = stripTrailingSemicolons(sql);

  // Only replace tokens like :from, :to, :channel_id — NOT :00, NOT :1, NOT ://
  const out = cleaned.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
    if (!(name in bindings)) {
      throw new Error(`Missing binding for :${name}`);
    }
    values.push(bindings[name]);
    return "?";
  });

  if (!/\blimit\b/i.test(out)) {
    return { sql: `${out} LIMIT 200`, values };
  }
  return { sql: out, values };
}

/** Truncates long string fields in result rows. */
function truncate(s, n = 1200) {
  if (typeof s !== "string") return s;
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Safe console preview of values (avoid huge dumps). */
function previewValues(arr, maxLen = 200) {
  try {
    return (arr || []).map((v) => {
      if (typeof v === "string") {
        return v.length > maxLen ? v.slice(0, maxLen) + "…" : v;
      }
      return v;
    });
  } catch {
    return arr;
  }
}

/* ----------------------------- Sanitizers (structured) ----------------------------- */

const ALLOWED_TABLES = new Set(["context_log", "summaries"]);
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function sanitizeSelect(selectRaw) {
  const s = String(selectRaw || "").trim();
  if (!s) throw new Error("select part missing");
  if (/[;]|--|\/\*|\*\//.test(s)) throw new Error("disallowed characters in select");
  if (/(\bunion\b|\bdrop\b|\balter\b|\binsert\b|\bupdate\b|\bdelete\b)/i.test(s)) {
    throw new Error("dangerous keyword in select");
  }
  if (!/^[\s\w.*,"'()`+\-/*.%<>!=:]+$/.test(s)) {
    throw new Error("select contains invalid characters");
  }
  return s;
}

/** FROM must be exactly one allowed table, optional alias. Accepts string or array. */
function sanitizeFrom(fromRaw) {
  let s = fromRaw;
  if (Array.isArray(fromRaw)) {
    if (fromRaw.length !== 1) throw new Error("exactly one table must be specified in from");
    s = fromRaw[0];
  }
  s = String(s || "").trim();
  if (!s) throw new Error("from part missing");
  if (/[;]|--|\/\*|\*\//.test(s)) throw new Error("disallowed characters in from");
  const m = s.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?$/i);
  if (!m) throw new Error("invalid from syntax");
  const table = m[1];
  const alias = m[2];
  if (!ALLOWED_TABLES.has(table)) throw new Error(`table '${table}' not allowed`);
  if (alias && !IDENTIFIER_RE.test(alias)) throw new Error("invalid alias");
  return alias ? `${table} ${alias}` : table;
}

function sanitizeWhere(whereRaw) {
  const s = String(whereRaw || "").trim();
  if (!s) return "";
  if (/[;]|--|\/\*|\*\//.test(s)) throw new Error("disallowed characters in where");
  if (/(\bunion\b|\bdrop\b|\balter\b|\binsert\b|\bupdate\b|\bdelete\b)/i.test(s)) {
    throw new Error("dangerous keyword in where");
  }
  if (!/^[\s\w."';(),%:+\-/*<>!=|&]+$/.test(s)) {
    throw new Error("where contains invalid characters");
  }
  return s;
}

/** Build final SQL from structured parts, inject channel filter + ORDER BY timestamp. */
function buildStructuredQuery(parts) {
  const selectPart = sanitizeSelect(parts.select);
  const fromPart = sanitizeFrom(parts.from);
  const wherePart = sanitizeWhere(parts.where);
  const whereClause = wherePart
    ? `(${wherePart}) AND (\`channel_id\` = :channel_id)`
    : `(\`channel_id\` = :channel_id)`;
  let sql = `SELECT ${selectPart} FROM ${fromPart} WHERE ${whereClause}`;
  sql = ensureOrderByTimestamp(sql);
  return sql;
}

/* ----------------------------- Legacy SQL parsing ----------------------------- */

/**
 * Parse a simple SELECT … FROM … [WHERE …] (ignores trailing ORDER BY / LIMIT).
 * Returns { select, from, where } or throws.
 */
function parseLegacySql(sqlIn) {
  const s = stripTrailingSemicolons(String(sqlIn || ""));
  const re =
    /^\s*select\s+([\s\S]+?)\s+from\s+([A-Za-z_][A-Za-z0-9_]*(?:\s+(?:as\s+)?[A-Za-z_][A-Za-z0-9_]*)?)\s*(?:where\s+([\s\S]*?))?(?:\border\s+by\b[\s\S]*)?$/i;
  const m = s.match(re);
  if (!m) throw new Error("Unsupported SQL shape. Provide 'select/from/where' parts or a simple 'SELECT … FROM … [WHERE …]'.");
  const rawSelect = m[1];
  const rawFrom = m[2];
  const rawWhere = m[3] || "";
  // sanitize using the same functions as structured mode
  const select = sanitizeSelect(rawSelect);
  const from = sanitizeFrom(rawFrom);
  const where = sanitizeWhere(rawWhere);
  return { select, from, where };
}

/* ----------------------------- Query helpers for modes ----------------------------- */

/** Extract channelId with graceful fallback (ctx -> runtime -> args). */
function resolveChannelId(ctxOrUndefined, runtime, args) {
  return (
    (ctxOrUndefined && ctxOrUndefined.channelId && String(ctxOrUndefined.channelId).trim()) ||
    (runtime && runtime.channel_id && String(runtime.channel_id).trim()) ||
    (args && args.channel_id && String(args.channel_id).trim()) ||
    ""
  );
}

/** Turns rows into a single text block for direct LLM context. */
function rowsToPassthroughText(rows) {
  return (rows || [])
    .map((r) => {
      const ts = r.timestamp ? new Date(r.timestamp).toISOString() : "";
      const speaker = r.sender || r.role || "unknown";
      const content = String(r.content ?? r.summary ?? "").trim();
      return `[${ts}] ${speaker}: ${content}`;
    })
    .join("\n");
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
  // lowercased unique terms, min length 2
  return [...new Set(terms.map((t) => t.toLowerCase()))].filter((t) => t.length >= 2);
}

/** AND-like clause for content LIKEs. */
function buildAndLike(terms) {
  if (!terms?.length) return { clause: "1=1", params: [] };
  const clause = terms.map(() => "content LIKE ?").join(" AND ");
  const params = terms.map((t) => `%${t}%`);
  return { clause, params };
}

/** Fetch match timestamps (context_log) within channel by AND terms */
async function fetchMatchTimestamps(db, channelId, terms, limit = 30) {
  const { clause, params } = buildAndLike(terms);
  const [rows] = await db.execute(
    `SELECT timestamp
       FROM context_log
      WHERE channel_id = ?
        AND ${clause}
   ORDER BY timestamp ASC
      LIMIT ?`,
    [channelId, ...params, Number(limit)]
  );
  return (rows || []).map((r) => r.timestamp);
}

/** Fetch a context window (±before/after by timestamp) within same channel. */
async function fetchContextWindowByTimestamp(db, channelId, matchTs, before = 10, after = 10) {
  // 10 vorherige im selben Kanal (rückwärts)
  const [prev] = await db.execute(
    `SELECT timestamp, role, sender, content
       FROM context_log
      WHERE channel_id = ?
        AND timestamp < ?
   ORDER BY timestamp DESC
      LIMIT ?`,
    [channelId, matchTs, Number(before)]
  );
  // die Match-Zeile selbst
  const [center] = await db.execute(
    `SELECT timestamp, role, sender, content
       FROM context_log
      WHERE channel_id = ?
        AND timestamp = ?
   ORDER BY timestamp ASC
      LIMIT 1`,
    [channelId, matchTs]
  );
  // 10 nachfolgende im selben Kanal (vorwärts)
  const [next] = await db.execute(
    `SELECT timestamp, role, sender, content
       FROM context_log
      WHERE channel_id = ?
        AND timestamp > ?
   ORDER BY timestamp ASC
      LIMIT ?`,
    [channelId, matchTs, Number(after)]
  );

  const prevAsc = [...prev].reverse();
  return [...prevAsc, ...center, ...next];
}

/** Merge windows (by timestamp+sender+role+content string key), return ASC by timestamp. */
function mergeDedupSortWindows(windows) {
  const seen = new Set();
  const all = [];
  for (const win of windows) {
    for (const r of win) {
      const key = `${r.timestamp}::${r.sender ?? ""}::${r.role ?? ""}::${r.content ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        all.push(r);
      }
    }
  }
  return all.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
}

/* ----------------------------- Tool entry ----------------------------- */

async function getHistory(toolFunction, ctxOrUndefined, _getAIResponse, runtime) {
  console.log("GET HISTORY ENTERED");
  try {
    const rawArgs =
      typeof toolFunction.arguments === "string"
        ? JSON.parse(toolFunction.arguments || "{}")
        : toolFunction.arguments || {};

    const mode = String(rawArgs.mode || "").toLowerCase(); // "", "raw", "passthrough", "qa"
    const channelId = resolveChannelId(ctxOrUndefined, runtime, rawArgs);
    if (!channelId) throw new Error("channel_id missing (context/runtime/args)");

    // ---------- MODE: QA ----------
    if (mode === "qa") {
      const question = String(rawArgs.query || rawArgs.question || "").trim();
      if (!question) {
        return JSON.stringify({ error: "HISTORY_QA_INPUT — Missing 'query' for QA mode." });
      }

      const terms = extractTerms(question);
      if (!terms.length) {
        return JSON.stringify({ result: "Keine nutzbaren Suchbegriffe vorhanden." });
      }

      const db = await getPool();

      // 1) Treffer nach AND-Keywords (nur context_log), limitierbar
      const MATCH_LIMIT = Number(rawArgs.match_limit || 30);
      const matchTimestamps = await fetchMatchTimestamps(db, channelId, terms, MATCH_LIMIT);
      if (!matchTimestamps.length) {
        return JSON.stringify({ result: "Keine Treffer im Verlauf gefunden." });
      }

      // 2) Für jeden Treffer Window ±10 im selben Kanal (via timestamp)
      const before = Number(rawArgs.before || 10);
      const after = Number(rawArgs.after || 10);

      const windows = [];
      for (const ts of matchTimestamps) {
        // eslint-disable-next-line no-await-in-loop
        const win = await fetchContextWindowByTimestamp(db, channelId, ts, before, after);
        windows.push(win);
      }

      // 3) Mergen + deduplizieren + chronologisch sortieren
      const contextRows = mergeDedupSortWindows(windows);

      // 4) Digest bauen und GPT-4.1 fragen
      const digest = rowsToPassthroughText(contextRows);
      const ctx = new Context();

      await ctx.add(
        "system",
        "history_qa",
        [
          "You are given chat log excerpts from a single Discord channel.",
          "Answer the user's question ONLY based on these excerpts.",
          "If the answer is not derivable, say so explicitly.",
          "Be concise and quote exact wording if the user asked for quotes.",
          "Language: respond in the user's language; prefer German if unsure.",
        ].join(" ")
      );
      await ctx.add("user", "question", question);
      await ctx.add("user", "context", digest);

      const QA_MODEL = "gpt-4.1";
      const QA_TOKENS = 1200;
      const out = await getAI(ctx, QA_TOKENS, QA_MODEL);
      const result = (out || "").trim() || "Keine Antwort ableitbar.";

      return JSON.stringify({ result });
    }

    // ---------- MODE: PASSTHROUGH ----------
    if (mode === "passthrough") {
      // Wie raw, aber Ausgabe als EIN Textblock (ohne KI).
      const { sql, values } = buildFinalSqlFromArgs(rawArgs, channelId);
      console.log("[getHistory][passthrough] SQL:", sql);
      console.log("[getHistory][passthrough] VALUES:", previewValues(values));

      const db = await getPool();
      const [rows] = await db.execute(sql, values);

      const text = rowsToPassthroughText(rows);
      return text || "";
    }

    // ---------- MODE: RAW (oder kein mode angegeben = Backcompat RAW) ----------
    {
      const { sql, values } = buildFinalSqlFromArgs(rawArgs, channelId);
      console.log("[getHistory][raw] SQL:", sql);
      console.log("[getHistory][raw] VALUES:", previewValues(values));

      const db = await getPool();
      const [rows] = await db.execute(sql, values);

      const safe = (rows || []).map((r) => {
        const obj = {};
        for (const [k, v] of Object.entries(r)) {
          obj[k] = v;
        }
        return obj;
      });

      return JSON.stringify({
        rowCount: safe.length,
        rows: safe,
      });
    }
  } catch (err) {
    console.error(err);
    return JSON.stringify({ error: `[ERROR]: ${err?.message || String(err)}` });
  }
}

/* ----------------------------- SQL builder (reused by raw/passthrough) ----------------------------- */

/** Baut den finalen SQL + values basierend auf structured parts oder legacy sql. */
function buildFinalSqlFromArgs(rawArgs, channelId) {
  const isStructured = rawArgs.select || rawArgs.from || rawArgs.where;
  const userBindings = rawArgs.bindings && typeof rawArgs.bindings === "object" ? rawArgs.bindings : {};

  if (isStructured) {
    let finalSQL = buildStructuredQuery({
      select: rawArgs.select,
      from: rawArgs.from,
      where: rawArgs.where,
    });
    const compiled = compileNamed(finalSQL, { ...userBindings, channel_id: channelId });
    finalSQL = compiled.sql;
    const values = compiled.values;
    return { sql: finalSQL, values };
  }

  if (rawArgs.sql) {
    const parsed = parseLegacySql(rawArgs.sql);
    const rebuilt = buildStructuredQuery(parsed); // fügt channel_id + ORDER BY automatisch hinzu
    const compiled = compileNamed(rebuilt, { ...userBindings, channel_id: channelId });
    return { sql: compiled.sql, values: compiled.values };
  }

  // Fallback: letzter Verlauf aus context_log in diesem Channel (kompatibel, sinnvoll für passthrough)
  const fallbackSql = ensureOrderByTimestamp(
    "SELECT timestamp, role, sender, content FROM context_log WHERE (`channel_id` = :channel_id)"
  );
  const compiled = compileNamed(fallbackSql, { channel_id: channelId });
  return { sql: compiled.sql, values: compiled.values };
}

module.exports = { getHistory };

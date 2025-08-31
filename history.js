// history.js — v2.2 (structured parts + safe builder + automatic channel filter + console logging)
// READ-ONLY MySQL SELECT over channel history (context_log, summaries).
// - Structured mode: { select, from, where, bindings } -> wir bauen finalen SQL sicher.
// - Legacy mode: args.sql -> wir PARSEN "SELECT … FROM … [WHERE …]" und bauen sicher neu.
// - channel_id wird AUTOMATISCH aus ctx.channelId (oder runtime.channel_id) genommen und immer
//   als zusätzlicher Filter eingefügt (kein :channel_id mehr erforderlich im Prompt).
// - Loggt den finalen SELECT (mit '?') und die Werte ins Console-Log.

const mysql = require("mysql2/promise");

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
 */
function compileNamed(sql, bindings) {
  const values = [];
  const cleaned = stripTrailingSemicolons(sql);

  const out = cleaned.replace(/:(\w+)/g, (_, name) => {
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

/** Build final SQL from structured parts */
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

/* ----------------------------- Tool entry ----------------------------- */

async function getHistory(toolFunction, ctxOrUndefined, _getAIResponse, runtime) {
  try {
    const rawArgs =
      typeof toolFunction.arguments === "string"
        ? JSON.parse(toolFunction.arguments || "{}")
        : toolFunction.arguments || {};

    // channel_id AUTOMATISCH aus Context; runtime nur Fallback
    const channelId =
      (ctxOrUndefined && ctxOrUndefined.channelId && String(ctxOrUndefined.channelId).trim()) ||
      (runtime && runtime.channel_id && String(runtime.channel_id).trim()) ||
      "";

    if (!channelId) throw new Error("channel_id missing from context");

    // Structured Mode?
    const isStructured = rawArgs.select || rawArgs.from || rawArgs.where;

    let finalSQL, values;
    const userBindings = (rawArgs.bindings && typeof rawArgs.bindings === "object") ? rawArgs.bindings : {};

    if (isStructured) {
      finalSQL = buildStructuredQuery({
        select: rawArgs.select,
        from: rawArgs.from,
        where: rawArgs.where,
      });
      const compiled = compileNamed(finalSQL, { ...userBindings, channel_id: channelId });
      finalSQL = compiled.sql;
      values = compiled.values;
    } else if (rawArgs.sql) {
      // Legacy: parse "SELECT … FROM … [WHERE …]" und bau sicher neu (mit Channel-Filter)
      const parsed = parseLegacySql(rawArgs.sql);
      const rebuilt = buildStructuredQuery(parsed); // fügt channel_id automatisch hinzu
      const compiled = compileNamed(rebuilt, { ...userBindings, channel_id: channelId });
      finalSQL = compiled.sql;
      values = compiled.values;
    } else {
      throw new Error("No query provided. Use structured parts {select, from, where, bindings} or legacy {sql, bindings}.");
    }

    // ---- Console logging of the final query ----
    console.log("[getHistory] SQL:", finalSQL);
    console.log("[getHistory] VALUES:", previewValues(values));

    const db = await getPool();
    const [rows] = await db.execute(finalSQL, values);

    const safe = (rows || []).map((r) => {
      const obj = {};
      for (const [k, v] of Object.entries(r)) {
        obj[k] = typeof v === "string" ? truncate(v) : v;
      }
      return obj;
    });

    return JSON.stringify({
      rowCount: safe.length,
      rows: safe,
    });
  } catch (err) {
    return JSON.stringify({ error: `[ERROR]: ${err?.message || String(err)}` });
  }
}

module.exports = { getHistory };

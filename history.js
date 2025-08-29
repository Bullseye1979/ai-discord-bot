// history.js — clean v1.1
// Run a flexible READ-ONLY MySQL SELECT over the channel history (context_log, summaries only).

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
      charset: "utf8mb4"
    });
  }
  return pool;
}

/** Compiles named placeholders (:name) into positional (?) and returns { sql, values }. Adds LIMIT if missing. */
function compileNamed(sql, bindings) {
  const values = [];
  const cleaned = String(sql || "").replace(/;+\s*$/, "");
  const out = cleaned.replace(/:(\w+)/g, (_, name) => {
    if (!(name in bindings)) {
      throw new Error(`Missing binding for :${name}`);
    }
    values.push(bindings[name]);
    return "?";
  });
  if (!/\blimit\s+\d+/i.test(out)) return { sql: `${out} LIMIT 200`, values };
  return { sql: out, values };
}

/** Truncates long string fields in result rows. */
function truncate(s, n = 1200) {
  if (typeof s !== "string") return s;
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Tool entry: executes a safe SELECT over context_log/summaries scoped to the provided channel_id. */
async function getHistory(toolFunction, ctxOrUndefined, _getAIResponse, runtime) {
  try {
    const args =
      typeof toolFunction.arguments === "string"
        ? JSON.parse(toolFunction.arguments || "{}")
        : (toolFunction.arguments || {});
    const sql = String(args.sql || "").trim();
    const extra = (args.bindings && typeof args.bindings === "object") ? args.bindings : {};

    if (!sql) throw new Error("SQL missing");

    let channelId = "";
    if (runtime && runtime.channel_id) channelId = String(runtime.channel_id).trim();
    else if (ctxOrUndefined && ctxOrUndefined.channelId) channelId = String(ctxOrUndefined.channelId).trim();
    if (!channelId) throw new Error("channel_id missing");

    const lowered = sql.toLowerCase();
    if (!lowered.startsWith("select")) throw new Error("Only SELECT is allowed");
    if (!/(from|join)\s+(context_log|summaries)\b/i.test(sql)) {
      throw new Error("Only tables context_log or summaries are allowed");
    }
    if (!/:channel_id\b/.test(sql)) throw new Error("Query must include :channel_id in WHERE");

    const bindings = { channel_id: channelId, ...extra };
    const { sql: compiled, values } = compileNamed(sql, bindings);

    const db = await getPool();
    const [rows] = await db.execute(compiled, values);

    const safe = (rows || []).map((r) => {
      const obj = {};
      for (const [k, v] of Object.entries(r)) obj[k] = typeof v === "string" ? truncate(v) : v;
      return obj;
    });

    return JSON.stringify({ rowCount: safe.length, rows: safe });
  } catch (err) {
    return JSON.stringify({ error: `[ERROR]: ${err?.message || String(err)}` });
  }
}

module.exports = { getHistory };

// tool.execContextSQL.js
// Version 1.0
// Führt einen READ-ONLY, flexiblen MySQL SELECT gegen context_log / summaries aus.
// Rückgabe: kompaktes JSON als String (geeignet als Kontext für Folgefragen).

const mysql = require("mysql2/promise");
require("dotenv").config();

let __pool = null;
async function getPool() {
  if (__pool) return __pool;
  __pool = await mysql.createPool({
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "discord_context",
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONN_LIMIT || 10),
    timezone: "Z",
    dateStrings: true,
    namedPlaceholders: true,
    multipleStatements: false,
  });
  return __pool;
}

function sanitizeSelect(sql) {
  const s = String(sql || "").trim();
  if (!/^select\b/i.test(s)) throw new Error("Only SELECT is allowed.");
  if (/[;`]/.test(s)) throw new Error("No statement separators/backticks allowed.");
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|call)\b/i.test(s)) {
    throw new Error("Write/DDL statements are not allowed.");
  }
  if (!/\b(context_log|summaries)\b/i.test(s)) {
    throw new Error("Query must reference context_log and/or summaries.");
  }
  return s;
}

function ensureLimit(sql) {
  return /\blimit\s+\d+/i.test(sql) ? sql : (sql + " LIMIT 200");
}

function truncateRowValues(row, maxLen = 800) {
  const out = {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (typeof v === "string" && v.length > maxLen) {
      out[k] = v.slice(0, maxLen) + "…";
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function history(toolFunction) {
  try {
    const args = JSON.parse(toolFunction.arguments || "{}");
    const sql = args.sql;
    const bindings = args.bindings || {};
    const channelId = args.channel_id || bindings.channel_id;

    if (!sql) return "[ERROR]: Missing 'sql' argument.";
    if (!channelId) return "[ERROR]: Missing 'channel_id' argument.";

    let safeSql = sanitizeSelect(sql);

    // Erzwinge, dass :channel_id tatsächlich im SQL verwendet wird
    if (!/:channel_id\b/.test(safeSql)) {
      return "[ERROR]: Your SELECT must include a channel filter using :channel_id (e.g. WHERE channel_id = :channel_id).";
    }

    safeSql = ensureLimit(safeSql);

    const pool = await getPool();
    const params = { ...bindings, channel_id: String(channelId) };
    const [rows] = await pool.execute(safeSql, params);

    const cleaned = Array.isArray(rows) ? rows.map(r => truncateRowValues(r)) : [];
    const payload = {
      rowCount: cleaned.length,
      rows: cleaned,
      note: "Rows truncated to fit; increase specificity (e.g., date range, speaker, LIKE) if needed."
    };

    return "```json\n" + JSON.stringify(payload, null, 2) + "\n```";
  } catch (err) {
    return "[ERROR]: " + (err?.message || String(err));
  }
}

module.exports = { history };

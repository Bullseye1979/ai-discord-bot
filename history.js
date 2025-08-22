// getHistory.js
// Flexible READ-ONLY SQL-Select über die Channel-History
// ALLOWED tables: context_log, summaries

const mysql = require('mysql2/promise');

let pool = null;
async function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 5,
      charset: 'utf8mb4'
    });
  }
  return pool;
}

// :named → ?  (und values[] in richtiger Reihenfolge)
function compileNamed(sql, bindings) {
  const values = [];
  const cleaned = String(sql || '').replace(/;+\s*$/,''); // trailing ; entfernen

  const out = cleaned.replace(/:(\w+)/g, (_, name) => {
    if (!(name in bindings)) {
      throw new Error(`Missing binding for :${name}`);
    }
    values.push(bindings[name]);
    return '?';
  });

  // Falls kein LIMIT vorhanden: begrenzen
  if (!/\blimit\s+\d+/i.test(out)) {
    return { sql: `${out} LIMIT 200`, values };
  }
  return { sql: out, values };
}

function truncate(s, n=1200) {
  if (typeof s !== 'string') return s;
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Tool-Entry (rückwärtskompatibel):
// getHistory(toolFunction, handoverContext, _getAIResponse, runtime)
async function getHistory(toolFunction, ctxOrUndefined, _getAIResponse, runtime) {
  try {
    const args = JSON.parse(toolFunction.arguments || '{}');
    const sql = String(args.sql || '').trim();
    const extra = (args.bindings && typeof args.bindings === 'object') ? args.bindings : {};

    if (!sql) throw new Error("sql missing");

    // channelId: bevorzugt aus runtime, sonst aus handoverContext.channelId
    let channelId = "";
    if (runtime && runtime.channel_id) {
      channelId = String(runtime.channel_id).trim();
    } else if (ctxOrUndefined && ctxOrUndefined.channelId) {
      channelId = String(ctxOrUndefined.channelId).trim();
    }
    if (!channelId) throw new Error("channel_id missing");

    // Sicherheitsgitter
    const lowered = sql.toLowerCase();
    if (!lowered.startsWith('select')) throw new Error("Only SELECT is allowed");
    if (!/(from|join)\s+(context_log|summaries)\b/i.test(sql)) {
      throw new Error("Only tables context_log or summaries are allowed");
    }
    if (!/:channel_id\b/.test(sql)) {
      throw new Error("Query must include :channel_id in WHERE");
    }

    // :channel_id IMMER bereitstellen (zusätzlich zu evtl. extra Bindings)
    const bindings = { channel_id: channelId, ...extra };

    const { sql: compiled, values } = compileNamed(sql, bindings);
    const db = await getPool();
    const [rows] = await db.execute(compiled, values);

    const safe = (rows || []).map(r => {
      const obj = {};
      for (const [k, v] of Object.entries(r)) {
        obj[k] = typeof v === 'string' ? truncate(v) : v;
      }
      return obj;
    });

    return JSON.stringify({ rowCount: safe.length, rows: safe });
  } catch (err) {
    return JSON.stringify({ error: String(err && err.message || err) });
  }
}

module.exports = { getHistory };

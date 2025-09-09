// history.js — v4.0 (single-mode: WHERE + PROMPT → GPT-4.1 summary)
// READ-ONLY MySQL SELECT over `context_log` scoped to a single channel.
// - You provide: { where, prompt, bindings? }
// - We run: SELECT timestamp, role, sender, content
//           FROM context_log
//           WHERE (channel_id = :channel_id) AND (<where>)
//           ORDER BY `timestamp` ASC
// - No LIMIT injected (you asked to rely on GPT-4.1).
// - Rows are concatenated into a digest and passed to GPT-4.1 with your prompt.
// - Returns JSON string: { result }
//
// Safety:
// - Channel scoping is *always* injected (ctx.channelId / runtime.channel_id / args.channel_id).
// - WHERE is sanitized against dangerous tokens; named bindings supported via :name.
// - ORDER BY timestamp ASC enforced.

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

/** Ensure ORDER BY `timestamp` ASC exists; inject before LIMIT if LIMIT present (we don't add a LIMIT). */
function ensureOrderByTimestamp(sql) {
  const s = stripTrailingSemicolons(sql);
  if (/\border\s+by\b/i.test(s)) return s;
  if (/\blimit\b/i.test(s)) {
    return s.replace(/\blimit\b/i, "ORDER BY `timestamp` ASC LIMIT");
  }
  return `${s} ORDER BY \`timestamp\` ASC`;
}

/**
 * Compiles :named placeholders into '?', returns { sql, values }.
 * IMPORTANT: names must start with [A-Za-z_] to avoid matching time literals like "10:00".
 * No default LIMIT is appended here.
 */
function compileNamed(sql, bindings) {
  const values = [];
  const cleaned = stripTrailingSemicolons(sql);

  const out = cleaned.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
    if (!(name in bindings)) {
      throw new Error(`Missing binding for :${name}`);
    }
    values.push(bindings[name]);
    return "?";
  });

  return { sql: out, values };
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

/** Light sanitizer for WHERE fragments. */
function sanitizeWhere(whereRaw) {
  const s = String(whereRaw || "").trim();
  if (!s) return "1=1";
  if (/[;]|--|\/\*|\*\//.test(s)) throw new Error("disallowed characters in where");
  if (/(\bunion\b|\bdrop\b|\balter\b|\binsert\b|\bupdate\b|\bdelete\b)/i.test(s)) {
    throw new Error("dangerous keyword in where");
  }
  if (!/^[\s\w."';(),%:+\-/*<>!=|&`]+$/.test(s)) {
    throw new Error("where contains invalid characters");
  }
  return s;
}

/** Turn rows into a single text block for LLM context. */
function rowsToDigest(rows) {
  return (rows || [])
    .map((r) => {
      const ts = r.timestamp ? new Date(r.timestamp).toISOString() : "";
      const speaker = r.sender || r.role || "unknown";
      const content = String(r.content ?? "").trim();
      return `[${ts}] ${speaker}: ${content}`;
    })
    .join("\n");
}

/** Extract channelId with graceful fallback (ctx -> runtime -> args). */
function resolveChannelId(ctxOrUndefined, runtime, args) {
  return (
    (ctxOrUndefined && ctxOrUndefined.channelId && String(ctxOrUndefined.channelId).trim()) ||
    (runtime && runtime.channel_id && String(runtime.channel_id).trim()) ||
    (args && args.channel_id && String(args.channel_id).trim()) ||
    ""
  );
}

/* ----------------------------- Tool entry ----------------------------- */

async function getHistory(toolFunction, ctxOrUndefined, _getAIResponse, runtime) {
  try {
    const rawArgs =
      typeof toolFunction.arguments === "string"
        ? JSON.parse(toolFunction.arguments || "{}")
        : toolFunction.arguments || {};

    const channelId = resolveChannelId(ctxOrUndefined, runtime, rawArgs);
    if (!channelId) throw new Error("channel_id missing (context/runtime/args)");

    const whereRaw = rawArgs.where;
    const where = sanitizeWhere(whereRaw);
    const prompt = String(rawArgs.prompt || "").trim();
    if (!prompt) {
      return JSON.stringify({ error: "HISTORY_INPUT — Missing 'prompt'." });
    }

    const bindings = (rawArgs.bindings && typeof rawArgs.bindings === "object") ? rawArgs.bindings : {};
    const db = await getPool();

    // Build final SQL (no LIMIT), enforce channel scope + ORDER BY
    let sql = `SELECT timestamp, role, sender, content
                 FROM context_log
                WHERE (\`channel_id\` = :channel_id) AND (${where})`;
    sql = ensureOrderByTimestamp(sql);

    const compiled = compileNamed(sql, { ...bindings, channel_id: channelId });

    console.log("[getHistory][WHERE+PROMPT] SQL:", compiled.sql);
    console.log("[getHistory][WHERE+PROMPT] VALUES:", previewValues(compiled.values));

    const [rows] = await db.execute(compiled.sql, compiled.values);

    const digest = rowsToDigest(rows);

    // Build LLM prompt
    const ctx = new Context();

    const IGNORE_RULE_LIGHT = [
      "Ignore meta-summaries and display-only summary outputs.",
      "Specifically, if a line's speaker is exactly 'summary' (case-insensitive) or the content starts with 'Summary'/'Zusammenfassung', do not treat those as source facts.",
      "However, DO respect explicit user instructions in the current prompt (e.g., if asked to include or compare past summaries)."
    ].join(" ");

    await ctx.add(
      "system",
      "history_where_prompt",
      [
        "You are given raw chat logs from a single Discord channel as plain text lines.",
        "Apply the user's instruction strictly to these logs.",
        "Keep factual accuracy, timeline, action items (owner & deadline), open questions, IDs/URLs, and numbers.",
        "Be concise but complete; structure with headings/bullets where helpful.",
        IGNORE_RULE_LIGHT
      ].join(" ")
    );

    // First, give the logs (digest) as context, then the user's prompt
    await ctx.add("user", "context", digest || "(no rows)");
    await ctx.add("user", "instruction", prompt);

    const MODEL = "gpt-4.1";
    const MAX_TOKENS = Math.max(1200, Number(process.env.HISTORY_SUMMARY_TOKENS || 3500));
    const out = await getAI(ctx, MAX_TOKENS, MODEL);
    const result = (out || "").trim() || "Keine zusammenfassbaren Inhalte.";

    return JSON.stringify({ result });
  } catch (err) {
    console.error("[getHistory][ERROR]", err?.message || err);
    return JSON.stringify({ error: `[ERROR]: ${err?.message || String(err)}` });
  }
}

module.exports = { getHistory };

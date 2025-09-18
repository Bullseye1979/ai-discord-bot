// readyStatus.js — v1.3 (Ready memory + optional refresh)
// - Remembers the last "Ready" text (default: "✅ Ready").
// - On ready-switch: caller sets the last ready text immediately so it stays visible.
// - maybeUpdateReadyStatus(client): roll 1..X; on hit, build a new <=30 chars one-liner from history
//   and update presence + memory. On miss or error: do nothing (keep current ready text).
//
// ENV:
//   READY_STATUS_ENABLED=1|0 (default 1)
//   READY_STATUS_DIE_MAX=integer (default 12)
//   READY_STATUS_MODEL=string (default "gpt-4o-mini")

require("dotenv").config();
const mysql = require("mysql2/promise");
const { setBotPresence } = require("./discord-helper.js");
const { getAI } = require("./aiService.js");
const Context = require("./context.js");

// ===== Ready memory (module-level) =====
let _lastReadyText = "✅ Ready";
function getLastReadyText() {
  return _lastReadyText;
}
function setLastReadyText(s) {
  const t = String(s || "").trim();
  _lastReadyText = t || "✅ Ready";
}

// ===== DB pool =====
let pool = null;
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
  }
  return pool;
}

// ===== helpers =====
function rollDie(max) {
  const m = Math.max(2, Math.floor(Number(max) || 12));
  return Math.floor(Math.random() * m) + 1;
}

function hardTrimOneLine(s, max = 30) {
  const one = String(s || "").replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return [...one].slice(0, max).join("");
}

async function fetchLastLogs(limit = 20) {
  const db = await getPool();
  const [rows] = await db.execute(
    `SELECT role, sender, content
       FROM context_log
   ORDER BY id DESC
      LIMIT ?`,
    [Math.max(1, Math.min(200, limit))]
  );
  return rows || [];
}

async function buildStatusFromLogs(rows, model, maxTokens = 64) {
  const lines = (rows || []).map(r => {
    const who = (r.sender || r.role || "user").toString().trim();
    const text = String(r.content || "").replace(/\r?\n/g, " ").trim();
    return `${who}: ${text}`;
  }).join("\n");

  const ctx = new Context(
    "",
    [
      "Create EXACTLY ONE single-line status, maximum 30 characters.",
      "No quotation marks.",
      "Use ONLY the provided chat snippets as inspiration; do not invent facts.",
      "No names, IDs, links, emojis, hashtags, or markdown.",
      "Always answer in english."
    ].join(" "),
    [],
    {},
    null,
    { skipInitialSummaries: true, persistToDB: false }
  );

  ctx.messages.push({ role: "user", name: "history", content: lines });

  const out = (await getAI(
    ctx,
    maxTokens,
    model || process.env.READY_STATUS_MODEL || "gpt-4o-mini"
  ))?.trim() || "";

  return hardTrimOneLine(out, 30);
}

/**
 * maybeUpdateReadyStatus(client)
 * - Call this AFTER you've switched to "ready" and shown the last ready text.
 * - Rolls 1..X; on 1, generates a new <=30-char line from recent history and updates presence + memory.
 * - On miss or any error, keeps the currently shown ready text unchanged.
 */
async function maybeUpdateReadyStatus(client) {
  try {
    const enabled = String(process.env.READY_STATUS_ENABLED ?? "1").trim() !== "0";
    if (!enabled) return;

    const dieMax = Math.max(2, Math.floor(Number(process.env.READY_STATUS_DIE_MAX || 12)));
    const hit = rollDie(dieMax) === 1;
    if (!hit) return;

    const rows = await fetchLastLogs(20);
    if (!rows.length) return;

    const line = await buildStatusFromLogs(rows, process.env.READY_STATUS_MODEL || "gpt-4o-mini");
    if (!line) return;

    setLastReadyText(line);                      // remember
    await setBotPresence(client, line, "online", 4); // update presence
  } catch (err) {
    // Silent fail: keep current ready text
    console.error("[readyStatus] failed:", err?.message || err);
  }
}

module.exports = {
  getLastReadyText,
  setLastReadyText,
  maybeUpdateReadyStatus
};

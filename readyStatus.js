// readyStatus.js — v1.4 (ready memory + cron + die roll)
// - Remembers the last "Ready" text (default: "✅ Ready").
// - maybeUpdateReadyStatus(client):
//     * Roll 1..X; on 1, generate a <= SOFTLEN one-liner from recent history,
//       hard-cut at HARDLEN, set presence, and remember it.
//     * On miss: do nothing (keep current ready text).
// - startReadyStatusCron(client):
//     * Runs every N minutes (READY_STATUS_CRON_MINUTES).
//     * Skips if current presence contains the hourglass "⌛" (bot busy).
//     * Otherwise calls maybeUpdateReadyStatus(client) — same die roll applies.
//
// ENV:
//   READY_STATUS_ENABLED=1|0          (default 1)
//   READY_STATUS_DIE_MAX=integer      (default 12)
//   READY_STATUS_MODEL=string         (default "gpt-4o-mini")
//   READY_STATUS_CRON_MINUTES=number  (default 15)

require("dotenv").config();
const mysql = require("mysql2/promise");
const cron = require("node-cron");
const { setBotPresence } = require("./discord-helper.js");
const { getAI } = require("./aiService.js");
const Context = require("./context.js");

// ---- soft vs hard length limits ----
const SOFTLEN = 30;  // model target (prompt)
const HARDLEN = 40;  // absolute safety cap

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

function hardTrimOneLine(input, max = HARDLEN) {
  const oneLine = String(input || "").replace(/\s+/g, " ").trim();
  if (!oneLine) return "";
  try {
    // Grapheme-safe (handles emojis/combining marks/ZWJ)
    const seg = new Intl.Segmenter("und", { granularity: "grapheme" });
    const graphemes = Array.from(seg.segment(oneLine), s => s.segment);
    if (graphemes.length <= max) return oneLine;
    return graphemes.slice(0, max).join("");
  } catch {
    // Fallback: code point slice
    const cp = [...oneLine];
    if (cp.length <= max) return oneLine;
    return cp.slice(0, max).join("");
  }
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
      `Create EXACTLY ONE single-line status, maximum ${SOFTLEN} characters.`,
      "No quotation marks.",
      "Use ONLY the provided chat snippets as inspiration; do not invent facts.",
      "No names, IDs, links, hashtags, or markdown.",
      "Avoid possible spoilers.",
      "Alwasy set an emoji at the beginning of the text, but NEVER use the hourglass emoji.",
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

  return hardTrimOneLine(out, HARDLEN);
}

/**
 * maybeUpdateReadyStatus(client)
 * - Call this AFTER you've switched to "ready" and shown the last ready text.
 * - Rolls 1..X; on 1, generates a new line from recent history and updates presence + memory.
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

    setLastReadyText(line);                         // remember
    await setBotPresence(client, line, "online", 4); // update presence (custom status)
  } catch (err) {
    // Silent fail: keep current ready text
    console.error("[readyStatus] failed:", err?.message || err);
  }
}

// ===== Cron (hourglass-aware) =====
function isBusyPresence(name) {
  if (!name) return false;
  return name.includes("⌛"); // only block when hourglass is shown
}

function startReadyStatusCron(client) {
  const interval = Number(process.env.READY_STATUS_CRON_MINUTES || 15);
  if (!interval || interval <= 0) return;

  const schedule = `*/${interval} * * * *`;

  cron.schedule(schedule, async () => {
    try {
      const presence = client.user?.presence?.activities?.[0]?.name || "";
      if (isBusyPresence(presence)) return; // skip if busy

      // Same die roll + generation logic as on ready-switch
      await maybeUpdateReadyStatus(client);
    } catch (err) {
      console.error("[readyStatus-cron] failed:", err?.message || err);
    }
  });

  console.log(`[readyStatus] Scheduled ready-status task every ${interval} min`);
}

module.exports = {
  getLastReadyText,
  setLastReadyText,
  maybeUpdateReadyStatus,
  startReadyStatusCron
};

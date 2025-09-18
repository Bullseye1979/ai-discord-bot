// readyStatus.js — v1.1 (no-fallback mode)
// - Wird nur bei "Ready-Switch" aufgerufen
// - Würfelt 1..X; nur bei "1" erzeugt & setzt einen KI-Einzeiler (<=30 Zeichen)
// - Bei Miss: macht GAR NICHTS -> alter Presence-Text bleibt bestehen

require("dotenv").config();
const mysql = require("mysql2/promise");
const { setBotPresence } = require("./discord-helper.js");
const { getAI } = require("./aiService.js");
const Context = require("./context.js");

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

function rollDie(max) {
  const m = Math.max(2, Math.floor(Number(max) || 12));
  return Math.floor(Math.random() * m) + 1;
}

function hardTrimOneLine(s, max = 30) {
  const one = String(s || "").replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  const slice = [...one].slice(0, max).join("");
  return slice;
}

async function fetchLastLogs(limit = 20) {
  const db = await getPool();
  const [rows] = await db.execute(
    `SELECT role, sender, content
       FROM context_log
   ORDER BY id DESC
      LIMIT ?`, [Math.max(1, Math.min(200, limit))]
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
      "Erzeuge genau EINEN EINZEILER (maximal 30 Zeichen), eine Zeile, ohne Anführungszeichen.",
      "Nutze NUR die folgenden Chat-Schnipsel als Inspiration, erfinde nichts dazu.",
      "Bevorzuge Deutsch, falls die Inhalte überwiegend deutsch sind.",
      "Keine vertraulichen Inhalte, keine Namen/IDs/Links.",
      "Kein Emoji, keine Hashtags, keine Markdown."
    ].join(" "),
    [],
    {},
    null,
    { skipInitialSummaries: true, persistToDB: false }
  );
  ctx.messages.push({ role: "user", name: "history", content: lines });

  const out = (await getAI(ctx, maxTokens, model || process.env.READY_STATUS_MODEL || "gpt-4o-mini"))?.trim() || "";
  return hardTrimOneLine(out, 30);
}

/**
 * maybeSetDynamicReady(client)
 * - Wird vom Call-Site NUR beim Wechsel in "ready" aufgerufen.
 * - Bei "1" => setze KI-Status (Custom Status, Activity-Type 4).
 * - Bei Miss => tue NICHTS (alter Presence-Text bleibt).
 */
async function maybeSetDynamicReady(client) {
  try {
    const enabled = String(process.env.READY_STATUS_ENABLED ?? "1").trim() !== "0";
    if (!enabled) return; // Feature aus, nichts setzen

    const dieMax = Math.max(2, Math.floor(Number(process.env.READY_STATUS_DIE_MAX || 12)));
    const hit = rollDie(dieMax) === 1;
    if (!hit) return; // Miss => gar nichts tun

    const rows = await fetchLastLogs(20);
    if (!rows.length) return; // keine Daten => gar nichts tun

    const line = await buildStatusFromLogs(rows, process.env.READY_STATUS_MODEL || "gpt-4o-mini");
    if (!line) return; // keine brauchbare Antwort => nichts tun

    await setBotPresence(client, line, "online", 4);
  } catch (err) {
    // bewusst still: bei Fehler alten Presence-Text nicht anfassen
    console.error("[readyStatus] failed:", err?.message || err);
  }
}

module.exports = { maybeSetDynamicReady };

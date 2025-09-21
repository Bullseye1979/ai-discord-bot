// readyStatus.js — v2.0 (presence allow-list via channel-config/*.json)
// - Lädt bei jedem Aufruf/Cron die Allow-List aus JSON-Dateien im Ordner channel-config/.
//   Dateiname = <channelId>.json; nur Dateien mit { "presence": 1 } werden berücksichtigt.
// - maybeUpdateReadyStatus(client, { force?: boolean }):
//     * Baut Allow-List dynamisch (zur Laufzeit wirksam).
//     * Rollt 1..X (READY_STATUS_DIE_MAX), außer force=true.
//     * Überspringt bei "⌛" (busy), außer force=true.
//     * Liest nur Logs aus erlaubten Channels (IN-Klausel).
//     * Setzt Presence auf Einzeiler (SOFTLEN/HARDLEN), speichert letzten Text im Speicher.
// - startReadyStatusCron(client):
//     * Läuft alle READY_STATUS_CRON_MINUTES Minuten (default 15).
//     * Nutzt dieselbe Logik wie maybeUpdateReadyStatus.
//
// ENV:
//   READY_STATUS_ENABLED=1|0
//   READY_STATUS_DIE_MAX=integer (default 12)
//   READY_STATUS_CRON_MINUTES=number (default 15)
//   READY_STATUS_MODEL=string (default "gpt-4o-mini")
//   CHANNEL_CONFIG_DIR=string (default "./channel-config")

require("dotenv").config();
const fs = require("fs");
const path = require("path");
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

/**
 * Lädt alle JSON-Dateien in CHANNEL_CONFIG_DIR (default ./channel-config) und
 * bildet eine Allow-List aller channel_ids, deren Datei "presence": 1 enthält.
 * Datei-Name muss <channelId>.json sein.
 */
function loadPresenceAllowList() {
  const dir = String(process.env.CHANNEL_CONFIG_DIR || "./channel-config").trim();
  const allow = [];

  try {
    if (!fs.existsSync(dir)) {
      console.warn(`[readyStatus] CHANNEL_CONFIG_DIR not found: ${dir}`);
      return allow;
    }

    const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".json"));
    for (const f of files) {
      const channelId = path.basename(f, ".json").trim();
      if (!channelId) continue;

      try {
        const raw = fs.readFileSync(path.join(dir, f), "utf8");
        const cfg = JSON.parse(raw);
        if (cfg && Number(cfg.presence) === 1) {
          allow.push(channelId);
        }
      } catch (e) {
        console.error(`[readyStatus] Failed to read/parse ${f}:`, e.message || e);
      }
    }
  } catch (e) {
    console.error("[readyStatus] loadPresenceAllowList error:", e.message || e);
  }

  return allow;
}

/**
 * Baut eine sichere IN-Klausel und Werte für mysql2 execute().
 * Gibt { clause: "IN (?, ?, ...)", values: [v1, v2, ...] } zurück.
 */
function buildInClause(values) {
  const arr = Array.from(values || []).filter(v => String(v || "").trim().length > 0);
  if (arr.length === 0) return { clause: "IN (?)", values: [["__EMPTY__"]] }; // nie matchen
  const ph = arr.map(() => "?").join(", ");
  return { clause: `IN (${ph})`, values: arr };
}

/**
 * Holt die letzten N Logs, aber NUR aus erlaubten Channels.
 */
async function fetchLastLogs(limit = 20, allowList = []) {
  const n = Math.max(1, Math.min(200, Number(limit) || 20));
  const db = await getPool();

  if (!Array.isArray(allowList) || allowList.length === 0) {
    // Kein erlaubter Channel -> nichts tun
    return [];
  }

  const { clause, values } = buildInClause(allowList);
  const sql =
    `SELECT channel_id, role, sender, content
       FROM context_log
      WHERE channel_id ${clause}
   ORDER BY id DESC
      LIMIT ?`;

  const params = [...values, n];
  const [rows] = await db.execute(sql, params);
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
      "Avoid possible spoilers. Do not mention fictional or real names, locations, monikers, group names. Be unspecific.",
      "Always set an emoji at the beginning of the text, but NEVER use the hourglass emoji.",
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
 * maybeUpdateReadyStatus(client, { force })
 * - Lädt Allow-List dynamisch
 * - Gibt bei leerer Allow-List ruhig auf
 * - Rollt die "Würfelchance", außer force = true
 * - Blockt bei "⌛", außer force = true
 */
async function maybeUpdateReadyStatus(client, opts = {}) {
  try {
    const enabled = String(process.env.READY_STATUS_ENABLED ?? "1").trim() !== "0";
    if (!enabled && !opts.force) return;

    const allowList = loadPresenceAllowList();
    if (!allowList.length) {
      console.log("[readyStatus] No channels with presence=1 found; skipping.");
      return;
    }

    const dieMax = Math.max(2, Math.floor(Number(process.env.READY_STATUS_DIE_MAX || 12)));
    const hit = opts.force ? true : (rollDie(dieMax) === 1);
    if (!hit) return;

    const presenceName = client.user?.presence?.activities?.[0]?.name || "";
    const busy = presenceName.includes("⌛");
    if (busy && !opts.force) return;

    const rows = await fetchLastLogs(20, allowList);
    if (!rows.length) {
      console.log("[readyStatus] No recent logs in allowed channels; skipping.");
      return;
    }

    const line = await buildStatusFromLogs(rows, process.env.READY_STATUS_MODEL || "gpt-4o-mini");
    if (!line) return;

    setLastReadyText(line);                           // remember
    await setBotPresence(client, line, "online", 4);  // update presence (custom status)
    console.log(`[readyStatus] presence updated: "${line}" (channels: ${allowList.length})`);
  } catch (err) {
    // Silent fail: keep current ready text
    console.error("[readyStatus] failed:", err?.message || err);
  }
}

// ===== Cron (hourglass-aware unless forced) =====
function startReadyStatusCron(client) {
  const interval = Number(process.env.READY_STATUS_CRON_MINUTES || 15);
  if (!interval || interval <= 0) return;

  const schedule = `*/${interval} * * * *`;

  cron.schedule(schedule, async () => {
    try {
      await maybeUpdateReadyStatus(client, { force: false });
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

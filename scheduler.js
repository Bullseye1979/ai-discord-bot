// scheduler.js — Auto-Summary per Channel via crontab
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const Context = require("./context.js");
const { getChannelConfig } = require("./discord-helper.js");

const jobs = new Map(); // channelId -> cron task

function listChannelConfigIds() {
  const dir = path.join(__dirname, "channel-config");
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json") && f !== "default.json");
  return files.map(f => path.basename(f, ".json"));
}

function ensureContextForChannel(channelId, contextStorage, channelMeta) {
  const key = `channel:${channelId}`;
  if (!contextStorage.has(key)) {
    const ctx = new Context(
      channelMeta.persona,
      channelMeta.instructions,
      channelMeta.tools,
      channelMeta.toolRegistry,
      channelId
    );
    contextStorage.set(key, ctx);
  }
  return contextStorage.get(key);
}

async function runSummaryOnce(channelId, contextStorage) {
  try {
    const meta = getChannelConfig(channelId);
    // Nur wenn es eine echte Config und eine crontab gab – (Aufruf ist trotzdem idempotent)
    if (!meta?.hasConfig || !meta?.crontab) return;

    const chatContext = ensureContextForChannel(channelId, contextStorage, meta);
    const cutoffMs = Date.now();

    // Nur zusammenfassen – keine Channel-Löschungen/Posts (still).
    await chatContext.summarizeSince(cutoffMs, meta.summaryPrompt || null);

    // Optional: Cursor bumpen (summarizeSince setzt sowieso, aber schadet nicht)
    await chatContext.bumpCursorToCurrentMax();

    console.log(`[CRON] Summarized channel ${channelId} at ${new Date().toISOString()}`);
  } catch (e) {
    console.error("[CRON] runSummaryOnce failed:", e?.message || e);
  }
}

function scheduleForChannel(channelId, contextStorage) {
  unscheduleForChannel(channelId); // erst alte stoppen

  const meta = getChannelConfig(channelId);
  if (!meta?.hasConfig || !meta?.crontab) {
    return false; // nichts zu tun
  }

  // Validierung durch node-cron (throws bei invalid)
  const task = cron.schedule(meta.crontab, () => runSummaryOnce(channelId, contextStorage), {
    timezone: "UTC" // optional: stell das auf deine gewünschte TZ
  });

  jobs.set(channelId, task);
  console.log(`[CRON] Scheduled channel ${channelId} -> ${meta.crontab}`);
  return true;
}

function unscheduleForChannel(channelId) {
  const t = jobs.get(channelId);
  if (t) {
    try { t.stop(); } catch {}
    jobs.delete(channelId);
    console.log(`[CRON] Unscheduled channel ${channelId}`);
  }
}

function initCron(contextStorage) {
  const ids = listChannelConfigIds();
  for (const id of ids) {
    try { scheduleForChannel(id, contextStorage); }
    catch (e) { console.error(`[CRON] Failed scheduling ${id}:`, e?.message || e); }
  }
}

function reloadCronForChannel(channelId, contextStorage) {
  try {
    const ok = scheduleForChannel(channelId, contextStorage);
    if (!ok) console.log(`[CRON] No crontab for ${channelId} (or no config).`);
    return ok;
  } catch (e) {
    console.error(`[CRON] reload failed for ${channelId}:`, e?.message || e);
    return false;
  }
}

module.exports = {
  initCron,
  reloadCronForChannel,
  runSummaryOnce,
};

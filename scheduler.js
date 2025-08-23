// scheduler.js — v1.0
// Lädt crontab aus channel-config/<channelId>.json und führt auto-summarize aus.
// Nach erfolgreicher Summary: Kanal leeren, 5 neueste Summaries posten, Cursor bump.

const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const {
  getChannelConfig,
  postSummariesIndividually,
} = require("./discord-helper.js");

// Wir benutzen deleteAllMessages und bumpCursor über chatContext + helper-Funktion in bot.js.
// deleteAllMessages ist dort implementiert; wir re-implementieren eine sichere Variante hier:
async function deleteAllMessagesSafe(channel) {
  try {
    const me = channel.guild.members.me;
    const perms = channel.permissionsFor(me);
    if (!perms?.has("ManageMessages") || !perms?.has("ReadMessageHistory")) {
      throw new Error("Missing ManageMessages/ReadMessageHistory");
    }
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    let beforeId = null;
    while (true) {
      const fetched = await channel.messages.fetch({ limit: 100, before: beforeId || undefined }).catch(() => null);
      if (!fetched || fetched.size === 0) break;
      for (const msg of fetched.values()) {
        if (msg.pinned) continue;
        try { await msg.delete(); } catch {}
        await sleep(120);
      }
      const oldest = fetched.reduce((acc, m) => (acc && acc.createdTimestamp < m.createdTimestamp ? acc : m), null);
      if (!oldest) break;
      beforeId = oldest.id;
    }
    return true;
  } catch (e) {
    console.warn("[scheduler] deleteAllMessagesSafe:", e?.message || e);
    return false;
  }
}

const JOBS = new Map(); // channelId -> cron task

function readAllChannelConfigs() {
  const dir = path.join(__dirname, "channel-config");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .map(f => f.replace(/\.json$/,""));
}

function scheduleOne(client, contextStorage, channelId) {
  const meta = getChannelConfig(channelId);
  // Nur wenn: echte Config-Datei + summariesEnabled + crontab vorhanden
  if (!meta?.hasConfig || !meta?.summariesEnabled) return false;

  const crontab = String(meta.crontab || "").trim();
  if (!crontab) return false;

  const tz = meta.crontab_tz || undefined;

  // Bereits existierenden Job stoppen
  if (JOBS.has(channelId)) {
    try { JOBS.get(channelId).stop(); } catch {}
    JOBS.delete(channelId);
  }

  const task = cron.schedule(crontab, async () => {
    try {
      // Channel abrufen
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased?.()) return;

      // Context beschaffen/erzeugen wie in bot.js
      const key = `channel:${channelId}`;
      if (!contextStorage.has(key)) {
        const Context = require("./context.js");
        const ctx = new Context(meta.persona, meta.instructions, meta.tools, meta.toolRegistry, channelId);
        contextStorage.set(key, { ctx, sig: "cron" });
      }
      const chatContext = contextStorage.get(key).ctx;

      // Vorher/Nachher zum Erkennen, ob neue Summary entstanden ist
      const before = await chatContext.getLastSummaries(1).catch(() => []);
      await chatContext.summarizeSince(Date.now(), meta.summaryPrompt || meta.summary_prompt || null);
      const after = await chatContext.getLastSummaries(1).catch(() => []);

      const createdNew =
        (before.length === 0 && after.length > 0) ||
        (before.length > 0 && after.length > 0 && after[0].timestamp !== before[0].timestamp);

      if (!createdNew) {
        // Nichts Neues -> nur Loggen, keine UI-Aktionen
        console.log(`[scheduler] No new messages to summarize for channel ${channelId}`);
        return;
      }

      // Kanal leeren
      const cleared = await deleteAllMessagesSafe(channel);
      if (!cleared) {
        await channel.send("⚠️ I lack permissions to delete messages (need Manage Messages + Read Message History).");
      }

      // 5 Summaries posten
      const last5Desc = await chatContext.getLastSummaries(5);
      const summariesAsc =
        (last5Desc || [])
          .slice()
          .reverse()
          .map((r) => `**${new Date(r.timestamp).toLocaleString()}**\n${r.summary}`);

      if (summariesAsc.length === 0) {
        await channel.send("No summaries available yet.");
      } else {
        await postSummariesIndividually(channel, summariesAsc, null);
      }

      // Cursor bumpen
      await chatContext.bumpCursorToCurrentMax().catch(() => {});
      console.log(`[scheduler] Summarized channel ${channelId}`);

    } catch (e) {
      console.error("[scheduler] job error:", e?.message || e);
    }
  }, { timezone: tz });

  JOBS.set(channelId, task);
  task.start();
  return true;
}

// Public API
function initCron(client, contextStorage) {
  // alle existierenden Jobs stoppen
  for (const t of JOBS.values()) { try { t.stop(); } catch {} }
  JOBS.clear();

  const ids = readAllChannelConfigs();
  let count = 0;
  for (const id of ids) {
    if (scheduleOne(client, contextStorage, id)) count++;
  }
  console.log(`[scheduler] Scheduled ${count} channels with crontab`);
}

async function reloadCronForChannel(client, contextStorage, channelId) {
  const ok = scheduleOne(client, contextStorage, channelId);
  return !!ok;
}

module.exports = { initCron, reloadCronForChannel };

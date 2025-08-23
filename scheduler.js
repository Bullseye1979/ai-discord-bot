// scheduler.js
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const { getChannelConfig, sendChunked } = require("./discord-helper.js");
const Context = require("./context.js");

const tasks = new Map(); // channelId -> task

function loadChannelIdsWithCrontab(dir) {
  const ids = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const full = path.join(dir, f);
    try {
      const json = JSON.parse(fs.readFileSync(full, "utf8"));
      if (typeof json.crontab === "string" && json.crontab.trim()) {
        const channelId = path.basename(f, ".json");
        ids.push({ channelId, crontab: json.crontab.trim() });
      }
    } catch {}
  }
  return ids;
}

async function runSummarizeForChannel(client, contextStorage, channelId) {
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    const meta = getChannelConfig(channelId);
    if (!meta || !meta.summaryPrompt) return;

    const key = `channel:${channelId}`;
    let ctx = contextStorage.get(key)?.ctx;
    if (!ctx) {
      ctx = new Context(meta.persona, meta.instructions, meta.tools, meta.toolRegistry, channelId);
      contextStorage.set(key, { ctx, sig: "cron" });
    }

    const cutoffMs = Date.now();
    const before = await ctx.getLastSummaries(1).catch(() => []);
    await ctx.summarizeSince(cutoffMs, meta.summaryPrompt);
    const after = await ctx.getLastSummaries(1).catch(() => []);

    const createdNew =
      (before.length === 0 && after.length > 0) ||
      (before.length > 0 && after.length > 0 && after[0].timestamp !== before[0].timestamp);

    if (!createdNew) return;

    // Channel leeren & 5 Summaries posten (optional)
    // -> Wenn du das bei Cron NICHT willst, kommentiere diesen Block aus.
    const me = channel.guild.members.me;
    const perms = channel.permissionsFor(me);
    if (perms?.has("ManageMessages") && perms?.has("ReadMessageHistory")) {
      // (kleine util wie in bot.js) – du kannst hier deine deleteAllMessages-Funktion wiederverwenden
      // await deleteAllMessages(channel);
    }

    const last5Desc = await ctx.getLastSummaries(5);
    const summariesAsc = (last5Desc || []).slice().reverse()
      .map(r => `**${new Date(r.timestamp).toLocaleString()}**\n${r.summary}`);
    if (summariesAsc.length) {
      for (let i = 0; i < summariesAsc.length; i++) {
        await sendChunked(channel, `**Summary ${i + 1}/${summariesAsc.length}**\n\n${summariesAsc[i]}`);
      }
    }

    console.log(`[scheduler] Summarized channel ${channelId}`);
  } catch (e) {
    console.warn("[scheduler] summarize failed:", e?.message || e);
  }
}

function initCron(client, contextStorage) {
  const dir = path.join(__dirname, "channel-config");
  const list = loadChannelIdsWithCrontab(dir);

  // existierende Tasks killen (bei reload)
  for (const t of tasks.values()) try { t.stop(); } catch {}
  tasks.clear();

  for (const { channelId, crontab } of list) {
    const task = cron.schedule(crontab, () => {
      runSummarizeForChannel(client, contextStorage, channelId);
    });
    tasks.set(channelId, task);
  }
  console.log(`[scheduler] Scheduled ${tasks.size} channels with crontab`);
}

function reloadCronForChannel(client, contextStorage, channelId) {
  const dir = path.join(__dirname, "channel-config");
  const cfgFile = path.join(dir, `${channelId}.json`);
  if (!fs.existsSync(cfgFile)) return false;

  try {
    const json = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    const crontab = String(json.crontab || "").trim();
    // alten Task stoppen
    const old = tasks.get(channelId);
    if (old) { try { old.stop(); } catch {}; tasks.delete(channelId); }

    if (!crontab) return false;
    const task = cron.schedule(crontab, () => {
      runSummarizeForChannel(client, contextStorage, channelId);
    });
    tasks.set(channelId, task);
    return true;
  } catch {
    return false;
  }
}

module.exports = { initCron, reloadCronForChannel };

// scheduler.js — clean v1.0
// Schedules posting "!summarize" into channels that have a valid crontab.

const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const { getChannelConfig } = require("./discord-helper.js");

const jobs = new Map();

/** Validates a crontab expression. */
function isValidCrontab(expr) {
  try { return typeof expr === "string" && cron.validate(expr); }
  catch { return false; }
}

/** Creates a cron task that posts "!summarize" to a channel. */
function scheduleSummarize(client, channelId, expr, timezone) {
  const opts = {};
  if (timezone && typeof timezone === "string") opts.timezone = timezone;

  return cron.schedule(
    expr,
    async () => {
      try {
        const chan = await client.channels.fetch(channelId).catch(() => null);
        if (!chan?.isTextBased?.()) return;
        await chan.send("!summarize");
      } catch (e) {
        console.error(`[scheduler] failed to trigger !summarize for ${channelId}:`, e?.message || e);
      }
    },
    opts
  );
}

/** Scans channel-config/*.json and (re)builds all cron jobs. */
function initCron(client) {
  try {
    const cfgDir = path.join(__dirname, "channel-config");
    if (!fs.existsSync(cfgDir)) {
      console.log("[scheduler] channel-config directory not found");
      return;
    }

    for (const [, job] of jobs) { try { job.stop(); } catch {} }
    jobs.clear();

    const files = fs.readdirSync(cfgDir).filter(f => f.endsWith(".json"));
    let scheduled = 0;

    for (const file of files) {
      const channelId = path.basename(file, ".json");
      if (channelId === "default") continue;

      let cfg = null;
      try {
        cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, file), "utf8"));
      } catch (e) {
        console.warn(`[scheduler] invalid JSON in ${file}:`, e?.message || e);
        continue;
      }

      const meta = getChannelConfig(channelId);
      if (!meta?.hasConfig) continue;
      if (!meta?.summariesEnabled) continue;

      const expr = cfg?.crontab;
      if (!isValidCrontab(expr)) continue;

      const timezone = cfg?.timezone || meta?.timezone;
      const task = scheduleSummarize(client, channelId, expr, timezone);

      jobs.set(channelId, task);
      scheduled++;
    }

    console.log(`[scheduler] scheduled ${scheduled} channels with crontab`);
  } catch (e) {
    console.error("[scheduler] initCron failed:", e?.message || e);
  }
}

/** Reloads the cron job for a single channel based on its config file. */
async function reloadCronForChannel(client, _contextStorage, channelId) {
  const old = jobs.get(channelId);
  if (old) { try { old.stop(); } catch {} jobs.delete(channelId); }

  const file = path.join(__dirname, "channel-config", `${channelId}.json`);
  if (!fs.existsSync(file) || channelId === "default") return false;

  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.warn(`[scheduler] invalid JSON in ${channelId}.json:`, e?.message || e);
    return false;
  }

  const meta = getChannelConfig(channelId);
  if (!meta?.hasConfig || !meta?.summariesEnabled) return false;

  const expr = cfg?.crontab;
  if (!isValidCrontab(expr)) return false;

  const timezone = cfg?.timezone || meta?.timezone;
  const task = scheduleSummarize(client, channelId, expr, timezone);

  jobs.set(channelId, task);
  return true;
}

module.exports = { initCron, reloadCronForChannel };

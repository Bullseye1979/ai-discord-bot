// bot.js — refactored v3.7
// Commands: !context, !summarize, !purge-db, !joinvc, !leavevc. Voice transcripts → AI reply + TTS. Cron support. Static /documents.

const { Client, GatewayIntentBits, PermissionsBitField } = require("discord.js");
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { getAIResponse } = require("./aiCore.js");
const { joinVoiceChannel, getVoiceConnection } = require("@discordjs/voice");
const { hasChatConsent, setChatConsent, setVoiceConsent } = require("./consent.js");
const { initCron, reloadCronForChannel } = require("./scheduler.js");
const Context = require("./context.js");
const {
  getSpeech,
  getChannelConfig,
  setReplyAsWebhookEmbed,
  setStartListening,
  setAddUserMessage,
  setBotPresence,
  sendChunked,
  resetTTSPlayer,
  resetRecordingFlag,
  postSummariesIndividually,
} = require("./discord-helper.js");
const { reportError } = require("./error.js");
require("dotenv").config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences,
  ],
});

const contextStorage = new Map();
const guildTextChannels = new Map(); // guildId -> textChannelId (for TTS/transcripts)
const voiceBusy = new Map(); // channelId -> boolean

/** Ensure a Context instance for a channel, rebuilding when config signature changes */
function ensureChatContextForChannel(channelId, storage, channelMeta) {
  try {
    const key = `channel:${channelId}`;
    const signature = crypto.createHash("sha1").update(JSON.stringify({
      persona: channelMeta.persona || "",
      instructions: channelMeta.instructions || "",
      tools: (channelMeta.tools || []).map(t => t?.function?.name || t?.name || "").sort(),
      botname: channelMeta.botname || "",
      voice: channelMeta.voice || "",
      summaryPrompt: channelMeta.summaryPrompt || ""
    })).digest("hex");

    if (!storage.has(key)) {
      const ctx = new Context(
        channelMeta.persona,
        channelMeta.instructions,
        channelMeta.tools,
        channelMeta.toolRegistry,
        channelId
      );
      storage.set(key, { ctx, sig: signature });
    } else {
      const entry = storage.get(key);
      if (entry.sig !== signature) {
        entry.ctx = new Context(
          channelMeta.persona,
          channelMeta.instructions,
          channelMeta.tools,
          channelMeta.toolRegistry,
          channelId
        );
        entry.sig = signature;
      }
    }
    return storage.get(key).ctx;
  } catch (err) {
    reportError(err, null, "ENSURE_CHAT_CONTEXT", "ERROR");
    // Fallback minimal context
    const ctx = new Context("", "", [], {}, channelId);
    return ctx;
  }
}

/** Check if the first “word” equals a given trigger name (case-insensitive) */
function firstWordEqualsName(text, triggerName) {
  if (!triggerName) return false;
  const t = String(triggerName).trim().toLowerCase();
  const m = String(text || "").trim().match(/^([^\s.,:;!?'"„“‚’«»()[\]{}<>—–-]+)/u);
  const first = (m?.[1] || "").toLowerCase();
  return first === t;
}

/** Strip a leading trigger name (with optional punctuation) from text */
function stripLeadingName(text, triggerName) {
  if (!triggerName) return String(text || "").trim();
  const esc = triggerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*${esc}\\s*[.,:;!?'"„“‚’«»()\\[\\]{}<>—–-]*\\s*`, "i");
  return String(text || "").replace(re, "").trim();
}

/** Compute a stable signature for a channel meta object */
function metaSig(m) {
  return crypto.createHash("sha1").update(JSON.stringify({
    persona: m.persona || "",
    instructions: m.instructions || "",
    tools: (m.tools || []).map(t => t?.function?.name || t?.name || "").sort(),
    botname: m.botname || "",
    voice: m.voice || "",
    summaryPrompt: m.summaryPrompt || ""
  })).digest("hex");
}

/** Check if a user is an admin for the current channel */
function isChannelAdmin(channelMeta, userId) {
  const ids = Array.isArray(channelMeta.admins) ? channelMeta.admins.map(String) : [];
  return ids.includes(String(userId));
}

/** Delete all non-pinned messages in a channel (requires permissions) */
async function deleteAllMessages(channel) {
  try {
    const me = channel.guild.members.me;
    const perms = channel.permissionsFor(me);
    if (!perms?.has(PermissionsBitField.Flags.ManageMessages) || !perms?.has(PermissionsBitField.Flags.ReadMessageHistory)) {
      throw new Error("Missing permissions: ManageMessages and/or ReadMessageHistory");
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let beforeId = null;

    while (true) {
      const fetched = await channel.messages.fetch({ limit: 100, before: beforeId || undefined }).catch(() => null);
      if (!fetched || fetched.size === 0) break;

      for (const msg of fetched.values()) {
        if (msg.pinned) continue;
        try { await msg.delete(); } catch {} // best-effort per message
        await sleep(120);
      }
      const oldest = fetched.reduce((acc, m) => (acc && acc.createdTimestamp < m.createdTimestamp ? acc : m), null);
      if (!oldest) break;
      beforeId = oldest.id;
    }
  } catch (err) {
    await reportError(err, channel, "DELETE_ALL_MESSAGES", "ERROR");
    throw err;
  }
}

/** Handle one voice transcript event → AI reply → webhook post → optional TTS */
async function handleVoiceTranscriptDirect(evt, client, storage) {
  let ch = null;
  let chatContext = null;
  try {
    ch = await client.channels.fetch(evt.channelId).catch(() => null);
    if (!ch) { return; }

    if (voiceBusy.get(evt.channelId)) {
      try { await ch.send("⏳ I’m answering already — please wait a moment."); } catch {}
      return;
    }

    const channelMeta = getChannelConfig(evt.channelId);
    chatContext = ensureChatContextForChannel(evt.channelId, storage, channelMeta);

    if (typeof chatContext.setUserWindow === "function") {
      chatContext.setUserWindow(channelMeta.max_user_messages, { prunePerTwoNonUser: true });
    }

    const tokenlimit = (() => {
      const raw = (channelMeta.max_tokens_speaker ?? channelMeta.maxTokensSpeaker);
      const v = Number(raw);
      const def = 1024;
      return Number.isFinite(v) && v > 0 ? Math.max(32, Math.min(8192, Math.floor(v))) : def;
    })();

    const sequenceLimit = 1;
    const instrBackup = chatContext.instructions;
    try {
      const add = (channelMeta.speechAppend || "").trim();
      if (add) chatContext.instructions = (chatContext.instructions || "") + "\n\n" + add;
    } catch {}

    voiceBusy.set(evt.channelId, true);

    let replyText = "";
    replyText = await getAIResponse(
      chatContext,
      tokenlimit,
      sequenceLimit,
      channelMeta.model || undefined,
      channelMeta.apikey || null
    );
    replyText = (replyText || "").trim();
    if (!replyText) return;

    try {
      await chatContext.add("assistant", channelMeta.botname || "AI", replyText, Date.now());
    } catch {}

    try {
      const msgShim = { channel: ch };
      await setReplyAsWebhookEmbed(msgShim, replyText, { botname: channelMeta.botname || "AI" });
    } catch (e) {
      await reportError(e, ch, "VOICE_WEBHOOK_SEND", "WARN");
      try { await ch.send(replyText); } catch {}
    }

    try {
      const conn = getVoiceConnection(evt.guildId);
      if (conn) {
        await getSpeech(conn, evt.guildId, replyText, client, channelMeta.voice || "");
      }
    } catch (e) {
      await reportError(e, ch, "VOICE_TTS", "WARN");
    } finally {
      try { chatContext.instructions = instrBackup; } catch {}
    }
  } catch (err) {
    await reportError(err, ch, "VOICE_TRANSCRIPT_DIRECT", "ERROR");
  } finally {
    voiceBusy.set(evt.channelId, false);
  }
}

client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;

    // Choose effective base channel (use parent for threads)
    const inThread = typeof message.channel.isThread === "function" ? message.channel.isThread() : false;
    const baseChannelId = inThread ? (message.channel.parentId || message.channel.id) : message.channel.id;

    const channelMeta = getChannelConfig(baseChannelId);
    if (!channelMeta) return;

    const key = `channel:${baseChannelId}`;
    const signature = metaSig(channelMeta);

    if (!contextStorage.has(key)) {
      const ctx = new Context(
        channelMeta.persona,
        channelMeta.instructions,
        channelMeta.tools,
        channelMeta.toolRegistry,
        baseChannelId
      );
      contextStorage.set(key, { ctx, sig: signature });
    } else {
      const entry = contextStorage.get(key);
      if (entry.sig !== signature) {
        entry.ctx = new Context(
          channelMeta.persona,
          channelMeta.instructions,
          channelMeta.tools,
          channelMeta.toolRegistry,
          baseChannelId
        );
        entry.sig = signature;
      }
    }
    const chatContext = contextStorage.get(key).ctx;

    const rawWindow = (channelMeta.max_user_messages ?? channelMeta.maxUserMessages ?? null);
    const parsedWindow =
      (rawWindow === null || rawWindow === undefined || rawWindow === "")
        ? null
        : (Number.isFinite(Number(rawWindow)) ? Number(rawWindow) : null);

    if (typeof chatContext.setUserWindow === "function") {
      chatContext.setUserWindow(parsedWindow, { prunePerTwoNonUser: true });
    }

    const rawText = (message.content || "").trim();
    const isCommand = rawText.startsWith("!");
    const selfIssued = message.author?.id === client.user?.id;

    // Admin-gated commands if channel has config
    if (isCommand) {
      if (!channelMeta.hasConfig) {
        await message.channel.send("⚠️ Commands are disabled in channels without a channel-config file.");
        return;
      }
      if (!selfIssued && !isChannelAdmin(channelMeta, message.author.id)) {
        await message.channel.send("⛔ You are not authorized to run commands in this channel.");
        return;
      }
    }

    // Log user message (non-webhook, non-bot)
    if (!message.author?.bot && !message.webhookId) {
      await setAddUserMessage(message, chatContext);
    }

    // Consent quick-commands
    {
      const authorId = String(message.author?.id || "");
      const lower = rawText.toLowerCase();

      if (lower.startsWith("+consent_chat")) {
        await setChatConsent(authorId, baseChannelId, true);
        await message.channel.send("✅ Chat consent saved for this channel.");
        return;
      }
      if (lower.startsWith("+withdrawl_chat")) {
        await setChatConsent(authorId, baseChannelId, false);
        await message.channel.send("✅ Chat consent withdrawn for this channel.");
        return;
      }
      if (lower.startsWith("+consent_voice")) {
        await setVoiceConsent(authorId, baseChannelId, true);
        await message.channel.send("✅ Voice consent saved for this channel.");
        return;
      }
      if (lower.startsWith("+withdrawl_voice")) {
        await setVoiceConsent(authorId, baseChannelId, false);
        await message.channel.send("✅ Voice consent withdrawn for this channel.");
        return;
      }
    }

    // !clear-channel / !purge-channel
    if (rawText.startsWith("!clear-channel") || rawText.startsWith("!purge-channel")) {
      try {
        await deleteAllMessages(message.channel);
        await message.channel.send("🧹 Channel cleared.");
      } catch (e) {
        await reportError(e, message.channel, "CMD_CLEAR_CHANNEL", "ERROR");
        await message.channel.send("⚠️ I lack permissions to delete messages (need Manage Messages + Read Message History).");
      }
      return;
    }

    // !context (view only)
    if (rawText.startsWith("!context")) {
      const chunks = await chatContext.getContextAsChunks();
      for (const c of chunks) await sendChunked(message.channel, `\`\`\`json\n${c}\n\`\`\``);
      return;
    }

    // !reload-cron
    if (rawText.startsWith("!reload-cron")) {
      try {
        const ok = await reloadCronForChannel(client, contextStorage, baseChannelId);
        await message.channel.send(ok ? "🔁 Cron reloaded for this channel." : "⚠️ No crontab defined for this channel.");
      } catch (e) {
        await reportError(e, message.channel, "CMD_RELOAD_CRON", "ERROR");
        await message.channel.send("❌ Failed to reload cron for this channel.");
      }
      return;
    }

    // !purge-db
    if (rawText.startsWith("!purge-db")) {
      try {
        const res = await chatContext.purgeChannelData();
        await message.channel.send(
          `🗑️ Purged database for this channel.\n- context_log deleted: **${res.contextDeleted}**\n- summaries deleted: **${res.summariesDeleted}**`
        );
      } catch (e) {
        await reportError(e, message.channel, "CMD_PURGE_DB", "ERROR");
        await message.channel.send("❌ Failed to purge database entries for this channel.");
      }
      return;
    }

    // !joinvc
    if (rawText.startsWith("!joinvc")) {
      try {
        let gm = null;
        try { gm = await message.guild.members.fetch(message.author.id); } catch {}
        const vc = gm?.voice?.channel || message.member?.voice?.channel;
        if (!vc) { await message.reply("Join a voice channel first."); return; }

        const old = getVoiceConnection(message.guild.id);
        if (old) { try { old.destroy(); } catch {} }

        resetRecordingFlag(message.guild.id);
        resetTTSPlayer(message.guild.id);

        const conn = joinVoiceChannel({
          channelId: vc.id,
          guildId: message.guild.id,
          adapterCreator: message.guild.voiceAdapterCreator,
          selfDeaf: false,
        });

        guildTextChannels.set(message.guild.id, message.channel.id);

        setStartListening(conn, message.guild.id, guildTextChannels, client, async (evt) => {
          try {
            const channelMeta2 = getChannelConfig(evt.channelId);
            const chatContext2 = ensureChatContextForChannel(evt.channelId, contextStorage, channelMeta2);

            if (typeof chatContext2.setUserWindow === "function") {
              chatContext2.setUserWindow(channelMeta2.max_user_messages, { prunePerTwoNonUser: true });
            }

            const TRIGGER = (channelMeta2.name || "").trim();
            const invoked = firstWordEqualsName(evt.text, TRIGGER);

            const textForLog = invoked ? stripLeadingName(evt.text, TRIGGER) : evt.text;
            try {
              await chatContext2.add("user", evt.speaker, (textForLog || "").trim(), evt.startedAtMs);
            } catch (e) {
              await reportError(e, null, "VOICE_LOG_CONTEXT", "WARN");
            }

            if (!invoked) return;

            if (voiceBusy.get(evt.channelId)) {
              try {
                const ch = await client.channels.fetch(evt.channelId).catch(() => null);
                await ch?.send("⏳ ...");
              } catch {}
              return;
            }

            await handleVoiceTranscriptDirect(
              { ...evt, text: textForLog },
              client,
              contextStorage
            );
          } catch (err) {
            await reportError(err, null, "VOICE_LISTENING_CALLBACK", "ERROR");
          }
        });

        await message.channel.send(`🔊 Connected to **${vc.name}**. Transcripts & TTS are now bound here.`);
      } catch (e) {
        await reportError(e, message.channel, "CMD_JOINVC", "ERROR");
        await message.channel.send("❌ Failed to join/move. Check my permissions (Connect/Speak) and try again.");
      }
      return;
    }

    // !leavevc
    if (rawText.startsWith("!leavevc")) {
      try {
        const conn = getVoiceConnection(message.guild.id);
        if (conn) {
          try { conn.destroy(); } catch {}
          guildTextChannels.delete(message.guild.id);
          await message.channel.send("👋 Left the voice channel.");
        } else {
          await message.channel.send("ℹ️ Not connected to a voice channel.");
        }
      } catch (e) {
        await reportError(e, message.channel, "CMD_LEAVEVC", "ERROR");
      }
      return;
    }

    // !summarize
    if (rawText.startsWith("!summarize")) {
      if (!channelMeta.summariesEnabled) {
        await message.channel.send("⚠️ Summaries are disabled in this channel.");
        return;
      }

      let progress = null;
      try { progress = await message.channel.send("⏳ **Summary in progress…** New messages won’t be considered."); } catch {}

      const cutoffMs = Date.now();
      const customPrompt = channelMeta?.summaryPrompt || channelMeta?.summary_prompt || null;

      try {
        const before = await chatContext.getLastSummaries(1).catch(() => []);
        await chatContext.summarizeSince(cutoffMs, customPrompt);
        const after = await chatContext.getLastSummaries(1).catch(() => []);
        const createdNew =
          (before.length === 0 && after.length > 0) ||
          (before.length > 0 && after.length > 0 && after[0].timestamp !== before[0].timestamp);

        if (!createdNew) {
          try { if (progress?.deletable) await progress.delete(); } catch {}
          await message.channel.send("ℹ️ No messages to summarize yet.");
          return;
        }
      } catch (e) {
        await reportError(e, message.channel, "CMD_SUMMARIZE_RUN", "ERROR");
        try { if (progress?.deletable) await progress.delete(); } catch {}
        await message.channel.send("❌ Summary failed.");
        return;
      }

      try {
        const last5Desc = await chatContext.getLastSummaries(5);
        const summariesAsc =
          (last5Desc || [])
            .slice()
            .reverse()
            .map((r) => `**${new Date(r.timestamp).toLocaleString()}**\n${r.summary}`);

        if (summariesAsc.length === 0) {
          await message.channel.send("No summaries available yet.");
        } else {
          await postSummariesIndividually(message.channel, summariesAsc, null);
        }
      } catch (e) {
        await reportError(e, message.channel, "CMD_SUMMARIZE_POST", "WARN");
      }

      try { await chatContext.bumpCursorToCurrentMax(); } catch (e) {
        await reportError(e, message.channel, "CMD_SUMMARIZE_BUMP", "WARN");
      }

      try {
        await chatContext.collapseToSystemAndLastSummary();
        await message.channel.send("🧠 RAM context collapsed to: **System + last summary**.");
      } catch (e) {
        await reportError(e, message.channel, "CMD_SUMMARIZE_COLLAPSE", "WARN");
        await message.channel.send("⚠️ RAM context collapse failed (kept full memory).");
      }

      try { await message.channel.send("✅ **Summary completed.**"); } catch {}
      try { if (progress?.deletable) await progress.delete(); } catch {}
      return;
    }

    // Normal flow: gated by explicit trigger name
    if (message.author?.bot || message.webhookId) return;
    const authorId = String(message.author?.id || "");
    const hasConsent = await hasChatConsent(authorId, baseChannelId);
    if (!hasConsent) return;

    const norm = (rawText || "").toLowerCase();
    const triggerName = (channelMeta.name || "bot").trim().toLowerCase();
    const isTrigger = norm.startsWith(triggerName) || norm.startsWith(`!${triggerName}`);
    if (!isTrigger) return;

    const state = { isAIProcessing: 0 };
    return require("./discord-handler.js").getProcessAIRequest(
      message,
      contextStorage.get(key).ctx,
      client,
      state,
      channelMeta.model,
      channelMeta.apikey
    );
  } catch (err) {
    await reportError(err, message?.channel, "ON_MESSAGE_CREATE", "ERROR");
  }
});

// Startup
(async () => {
  try {
    await client.login(process.env.DISCORD_TOKEN);
  } catch (err) {
    reportError(err, null, "LOGIN", "FATAL");
  }
})();
client.once("ready", () => {
  try {
    setBotPresence(client, "✅ Started", "online");
    initCron(client, contextStorage);
  } catch (err) {
    reportError(err, null, "READY_INIT", "ERROR");
  }
});

// Static /documents
const expressApp = express();
const documentDirectory = path.join(__dirname, "documents");
expressApp.use(
  "/documents",
  express.static(documentDirectory, {
    index: false,
    extensions: false,
    setHeaders: (res) => {
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("Access-Control-Allow-Origin", "*");
    },
  })
);
expressApp.listen(3000, () => {});

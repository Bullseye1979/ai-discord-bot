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
const { getProcessAIRequest } = require("./discord-handler.js"); // <-- FIX: Importieren
const { reportError, reportInfo } = require("./error.js");

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
    reportError(err, null, "ENSURE_CHAT_CONTEXT");
    // Fallback minimaler Context
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
        try { await msg.delete(); } catch {} // pro Nachricht best-effort
        await sleep(120);
      }
      const oldest = fetched.reduce((acc, m) => (acc && acc.createdTimestamp < m.createdTimestamp ? acc : m), null);
      if (!oldest) break;
      beforeId = oldest.id;
    }
  } catch (err) {
    await reportError(err, channel, "DELETE_ALL_MESSAGES");
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
      await reportInfo(ch, "⏳ Ich antworte gerade — bitte kurz warten.", "VOICE_BUSY");
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
      await reportError(e, ch, "VOICE_WEBHOOK_SEND");
      try { await ch.send(replyText); } catch {}
    }

    try {
      const conn = getVoiceConnection(evt.guildId);
      if (conn) {
        await getSpeech(conn, evt.guildId, replyText, client, channelMeta.voice || "");
      }
    } catch (e) {
      await reportError(e, ch, "VOICE_TTS");
    } finally {
      try { chatContext.instructions = instrBackup; } catch {}
    }
  } catch (err) {
    await reportError(err, ch, "VOICE_TRANSCRIPT_DIRECT");
  } finally {
    voiceBusy.set(evt.channelId, false);
  }
}

client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;

    const baseChannelId = message.channelId;
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

    if (isCommand) {
      if (!channelMeta.hasConfig) {
        await reportInfo(message.channel, "⚠️ Commands are disabled in channels without a channel-config file.", "CMD_DISABLED");
        return;
      }
      if (!selfIssued && !isChannelAdmin(channelMeta, message.author.id)) {
        await reportInfo(message.channel, "⛔ You are not authorized to run commands in this channel.", "CMD_FORBIDDEN");
        return;
      }
    }

    if (!message.author?.bot && !message.webhookId) {
      await setAddUserMessage(message, chatContext);
    }

    // Consent quick-commands
    {
      const authorId = String(message.author?.id || "");
      const lower = rawText.toLowerCase();

      if (lower.startsWith("+consent_chat")) {
        await setChatConsent(authorId, baseChannelId, true);
        await reportInfo(message.channel, "✅ Chat consent saved for this channel.", "CONSENT_CHAT_ON");
        return;
      }
      if (lower.startsWith("+withdrawl_chat")) {
        await setChatConsent(authorId, baseChannelId, false);
        await reportInfo(message.channel, "✅ Chat consent withdrawn for this channel.", "CONSENT_CHAT_OFF");
        return;
      }
      if (lower.startsWith("+consent_voice")) {
        await setVoiceConsent(authorId, baseChannelId, true);
        await reportInfo(message.channel, "✅ Voice consent saved for this channel.", "CONSENT_VOICE_ON");
        return;
      }
      if (lower.startsWith("+withdrawl_voice")) {
        await setVoiceConsent(authorId, baseChannelId, false);
        await reportInfo(message.channel, "✅ Voice consent withdrawn for this channel.", "CONSENT_VOICE_OFF");
        return;
      }
    }

    // !clear-channel / !purge-channel
    if (rawText.startsWith("!clear-channel") || rawText.startsWith("!purge-channel")) {
      try {
        await deleteAllMessages(message.channel);
        await reportInfo(message.channel, "🧹 Channel cleared.", "CMD_CLEAR_CHANNEL_OK");
      } catch (e) {
        await reportError(e, message.channel, "CMD_CLEAR_CHANNEL");
        await reportInfo(message.channel, "⚠️ I lack permissions to delete messages (need Manage Messages + Read Message History).", "CMD_CLEAR_CHANNEL_PERMS");
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
        await reportInfo(message.channel, ok ? "🔁 Cron reloaded for this channel." : "⚠️ No crontab defined for this channel.", "CMD_RELOAD_CRON");
      } catch (e) {
        await reportError(e, message.channel, "CMD_RELOAD_CRON");
        await reportInfo(message.channel, "❌ Failed to reload cron for this channel.", "CMD_RELOAD_CRON_FAIL");
      }
      return;
    }

    // !purge-db
    if (rawText.startsWith("!purge-db")) {
      try {
        const res = await chatContext.purgeChannelData();
        await reportInfo(
          message.channel,
          `🗑️ Purged database for this channel.\n- context_log deleted: **${res.contextDeleted}**\n- summaries deleted: **${res.summariesDeleted}**`,
          "CMD_PURGE_DB_OK"
        );
      } catch (e) {
        await reportError(e, message.channel, "CMD_PURGE_DB");
        await reportInfo(message.channel, "❌ Failed to purge database entries for this channel.", "CMD_PURGE_DB_FAIL");
      }
      return;
    }

    // !joinvc
    if (rawText.startsWith("!joinvc")) {
      try {
        let gm = null;
        try { gm = await message.guild.members.fetch(message.author.id); } catch {}
        const vc = gm?.voice?.channel || message.member?.voice?.channel;
        if (!vc) { await reportInfo(message.channel, "Join a voice channel first.", "CMD_JOINVC_NEEDS_VC"); return; }

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
            const channelMeta = getChannelConfig(evt.channelId);
            const chatContext = ensureChatContextForChannel(evt.channelId, contextStorage, channelMeta);

            if (typeof chatContext.setUserWindow === "function") {
              chatContext.setUserWindow(channelMeta.max_user_messages, { prunePerTwoNonUser: true });
            }

            const TRIGGER = (channelMeta.name || "").trim();
            const invoked = firstWordEqualsName(evt.text, TRIGGER);

            const textForLog = invoked ? stripLeadingName(evt.text, TRIGGER) : evt.text;
            try {
              await chatContext.add("user", evt.speaker, (textForLog || "").trim(), evt.startedAtMs);
            } catch (e) {
              await reportError(e, null, "VOICE_LOG_CONTEXT");
            }

            if (!invoked) return;

            if (voiceBusy.get(evt.channelId)) {
              try {
                const ch = await client.channels.fetch(evt.channelId).catch(() => null);
                await reportInfo(ch, "⏳ ...", "VOICE_BUSY");
              } catch {}
              return;
            }

            await handleVoiceTranscriptDirect(
              { ...evt, text: textForLog },
              client,
              contextStorage
            );
          } catch (err) {
            await reportError(err, null, "VOICE_LISTENING_CALLBACK");
          }
        });

        await reportInfo(message.channel, `🔊 Connected to **${vc.name}**. Transcripts & TTS are now bound here.`, "CMD_JOINVC_OK");
      } catch (e) {
        await reportError(e, message.channel, "CMD_JOINVC");
        await reportInfo(message.channel, "❌ Failed to join/move. Check my permissions (Connect/Speak) and try again.", "CMD_JOINVC_FAIL");
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
          await reportInfo(message.channel, "👋 Left the voice channel.", "CMD_LEAVEVC_OK");
        } else {
          await reportInfo(message.channel, "ℹ️ Not connected to a voice channel.", "CMD_LEAVEVC_NONE");
        }
      } catch (e) {
        await reportError(e, message.channel, "CMD_LEAVEVC");
      }
      return;
    }

    // !summarize
    if (rawText.startsWith("!summarize")) {
      if (!channelMeta.summariesEnabled) {
        await reportInfo(message.channel, "⚠️ Summaries are disabled in this channel.", "CMD_SUMMARIZE_DISABLED");
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
          await reportInfo(message.channel, "ℹ️ No messages to summarize yet.", "CMD_SUMMARIZE_EMPTY");
          return;
        }
      } catch (e) {
        await reportError(e, message.channel, "CMD_SUMMARIZE_RUN");
        try { if (progress?.deletable) await progress.delete(); } catch {}
        await reportInfo(message.channel, "❌ Summary failed.", "CMD_SUMMARIZE_FAIL");
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
          await reportInfo(message.channel, "No summaries available yet.", "CMD_SUMMARIZE_NONE");
        } else {
          await postSummariesIndividually(message.channel, summariesAsc, null);
        }
      } catch (e) {
        await reportError(e, message.channel, "CMD_SUMMARIZE_POST");
      }

      try { await chatContext.bumpCursorToCurrentMax(); } catch (e) {
        await reportError(e, message.channel, "CMD_SUMMARIZE_BUMP");
      }

      try {
        await chatContext.collapseToSystemAndLastSummary();
        await reportInfo(message.channel, "🧠 RAM context collapsed to: **System + last summary**.", "CMD_SUMMARIZE_COLLAPSE_OK");
      } catch (e) {
        await reportError(e, message.channel, "CMD_SUMMARIZE_COLLAPSE");
        await reportInfo(message.channel, "⚠️ RAM context collapse failed (kept full memory).", "CMD_SUMMARIZE_COLLAPSE_FAIL");
      }

      try { await reportInfo(message.channel, "✅ **Summary completed.**", "CMD_SUMMARIZE_DONE"); } catch {}
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
    return getProcessAIRequest(
      message,
      chatContext,
      client,
      state,
      channelMeta.model,
      channelMeta.apikey
    );
  } catch (err) {
    await reportError(err, message?.channel, "ON_MESSAGE_CREATE");
  }
});

// Startup
(async () => {
  try {
    await client.login(process.env.DISCORD_TOKEN);
  } catch (err) {
    // Kein Channel verfügbar; nur Logging via reportError
    reportError(err, null, "LOGIN");
  }
})();
client.once("ready", () => {
  try {
    setBotPresence(client, "✅ Started", "online");
    initCron(client, contextStorage);
  } catch (err) {
    reportError(err, null, "READY_INIT");
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

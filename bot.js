// bot.js — v3.9 (BUSY once-per-phase + yellow, color-coded embeds via error.js)
// Commands: !context, !summarize, !purge-db, !joinvc, !leavevc.
// Voice transcripts → AI reply + TTS. Cron support. Static /documents.

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
const voiceBusy = new Map();         // channelId -> boolean

// NEW: BUSY announcement is shown only once per busy phase
const busyAnnounced = new Map();     // channelId -> boolean
const BUSY_TEXT =
  "🔊 **I'm currently speaking a response.**\n" +
  "I can handle only one voice request per channel at a time to keep things clear. " +
  "Please wait a moment — as soon as I'm done, I'll listen again and take the next input.\n\n" +
  "_Tip:_ You don't need to repeat your question.";

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
    const ctx = new Context("", "", [], {}, channelId);
    return ctx;
  }
}

/** If the first word equals trigger name (case-insensitive) */
function firstWordEqualsName(text, triggerName) {
  if (!triggerName) return false;
  const t = String(triggerName).trim().toLowerCase();
  const m = String(text || "").trim().match(/^([^\s.,:;!?'"„“‚’«»()[\]{}<>—–-]+)/u);
  const first = (m?.[1] || "").toLowerCase();
  return first === t;
}

/** Strip a leading trigger name + optional punctuation */
function stripLeadingName(text, triggerName) {
  if (!triggerName) return String(text || "").trim();
  const esc = triggerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*${esc}\\s*[.,:;!?'"„“‚’«»()\\[\\]{}<>—–-]*\\s*`, "i");
  return String(text || "").replace(re, "").trim();
}

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

function isChannelAdmin(channelMeta, userId) {
  const ids = Array.isArray(channelMeta.admins) ? channelMeta.admins.map(String) : [];
  return ids.includes(String(userId));
}

/** Delete all non-pinned messages in a channel */
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
        try { await msg.delete(); } catch {}
        await sleep(120);
      }
      const oldest = fetched.reduce((acc, m) => (acc && acc.createdTimestamp < m.createdTimestamp ? acc : m), null);
      if (!oldest) break;
      beforeId = oldest.id;
    }
  } catch (err) {
    await reportError(err, channel, "DELETE_ALL_MESSAGES", { details: "Failed to clear channel." });
    throw err;
  }
}

/** Voice transcript → AI reply → webhook post → optional TTS */
async function handleVoiceTranscriptDirect(evt, client, storage) {
  let ch = null;
  let chatContext = null;
  try {
    ch = await client.channels.fetch(evt.channelId).catch(() => null);
    if (!ch) { return; }

    // If busy: show BUSY only once per busy phase (yellow embed)
    if (voiceBusy.get(evt.channelId)) {
      if (!busyAnnounced.get(evt.channelId)) {
        await reportInfo(ch, BUSY_TEXT, "BUSY"); // colored yellow in error.js
        busyAnnounced.set(evt.channelId, true);
      }
      return;
    }

    const channelMeta = getChannelConfig(evt.channelId);
    chatContext = ensureChatContextForChannel(evt.channelId, storage, channelMeta);

    if (typeof chatContext.setUserWindow === "function") {
      chatContext.setUserWindow(channelMeta.max_user_messages, { prunePerTwoNonUser: true });
    }

    // Optional block selection for voice (speaker/user-based overrides)
    const blocks = Array.isArray(channelMeta.blocks) ? channelMeta.blocks : [];
    const speakerNameLower = String(evt.speaker || "").trim().toLowerCase();
    const userId = String(evt.userId || "").trim();

    const pickBlockForSpeaker = () => {
      let exact = null, wildcard = null;
      for (const b of blocks) {
        const sp = Array.isArray(b.speaker) ? b.speaker.map(s => String(s).trim().toLowerCase()) : [];
        if (!sp.length) continue;
        if (sp.includes("*") && !wildcard) wildcard = b;
        if (speakerNameLower && sp.includes(speakerNameLower) && !exact) exact = b;
      }
      return exact || wildcard || null;
    };
    const pickBlockForUser = () => {
      let exact = null, wildcard = null;
      for (const b of blocks) {
        const us = Array.isArray(b.user) ? b.user.map(x => String(x).trim()) : [];
        if (!us.length) continue;
        if (us.includes("*") && !wildcard) wildcard = b;
        if (userId && us.includes(userId) && !exact) exact = b;
      }
      return exact || wildcard || null;
    };

    const matchingBlock = pickBlockForSpeaker() || pickBlockForUser();

    let effectiveModel  = matchingBlock?.model  || channelMeta.model || undefined;
    let effectiveApiKey = matchingBlock?.apikey || channelMeta.apikey || null;

    if (matchingBlock && Array.isArray(matchingBlock.tools) && matchingBlock.tools.length > 0) {
      const { tools: blockTools, registry: blockRegistry } = require("./tools.js").getToolRegistry(matchingBlock.tools);
      chatContext.tools = blockTools;
      chatContext.toolRegistry = blockRegistry;
    } else {
      chatContext.tools = channelMeta.tools;
      chatContext.toolRegistry = channelMeta.toolRegistry;
    }

    // Token limit for voice mode
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
      effectiveModel,
      effectiveApiKey
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
      try { await reportInfo(ch, replyText, "FALLBACK"); } catch {}
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
    // End of busy phase → reset both flags
    voiceBusy.set(evt.channelId, false);
    busyAnnounced.delete(evt.channelId);
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
        await reportInfo(message.channel, "Commands are disabled in channels without a channel-config file.", "COMMANDS");
        return;
      }
      if (!selfIssued && !isChannelAdmin(channelMeta, message.author.id)) {
        await reportInfo(message.channel, "You are not authorized to run commands in this channel.", "COMMANDS");
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
        await reportInfo(message.channel, "Chat consent saved for this channel.", "CONSENT");
        return;
      }
      if (lower.startsWith("+withdrawl_chat")) {
        await setChatConsent(authorId, baseChannelId, false);
        await reportInfo(message.channel, "Chat consent withdrawn for this channel.", "CONSENT");
        return;
      }
      if (lower.startsWith("+consent_voice")) {
        await setVoiceConsent(authorId, baseChannelId, true);
        await reportInfo(message.channel, "Voice consent saved for this channel.", "CONSENT");
        return;
      }
      if (lower.startsWith("+withdrawl_voice")) {
        await setVoiceConsent(authorId, baseChannelId, false);
        await reportInfo(message.channel, "Voice consent withdrawn for this channel.", "CONSENT");
        return;
      }
    }

    // !clear-channel / !purge-channel
    if (rawText.startsWith("!clear-channel") || rawText.startsWith("!purge-channel")) {
      try {
        await deleteAllMessages(message.channel);
        await reportInfo(message.channel, "Channel cleared.", "MAINTENANCE");
      } catch (e) {
        await reportError(e, message.channel, "CMD_CLEAR_CHANNEL");
        await reportInfo(message.channel, "I lack permissions (Manage Messages + Read Message History).", "MAINTENANCE");
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
        await reportInfo(message.channel, ok ? "Cron reloaded for this channel." : "No crontab defined for this channel.", "CRON");
      } catch (e) {
        await reportError(e, message.channel, "CMD_RELOAD_CRON");
        await reportInfo(message.channel, "Failed to reload cron for this channel.", "CRON");
      }
      return;
    }

    // !purge-db
    if (rawText.startsWith("!purge-db")) {
      try {
        const res = await chatContext.purgeChannelData();
        await reportInfo(
          message.channel,
          `Purged database for this channel.\n- context_log deleted: **${res.contextDeleted}**\n- summaries deleted: **${res.summariesDeleted}**`,
          "MAINTENANCE"
        );
      } catch (e) {
        await reportError(e, message.channel, "CMD_PURGE_DB");
        await reportInfo(message.channel, "Failed to purge database entries for this channel.", "MAINTENANCE");
      }
      return;
    }

    // !joinvc
    if (rawText.startsWith("!joinvc")) {
      try {
        let gm = null;
        try { gm = await message.guild.members.fetch(message.author.id); } catch {}
        const vc = gm?.voice?.channel || message.member?.voice?.channel;
        if (!vc) { await reportInfo(message.channel, "Join a voice channel first.", "VOICE"); return; }

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
        await reportInfo(message.channel, `Connected to **${vc.name}**. Transcripts & TTS are now bound here.`, "VOICE");

        // Voice listener — do NOT send BUSY here; let handleVoiceTranscriptDirect manage the one-time BUSY notice.
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

            await handleVoiceTranscriptDirect(
              { ...evt, text: textForLog },
              client,
              contextStorage
            );
          } catch (err) {
            await reportError(err, null, "VOICE_LISTENING_CALLBACK");
          }
        });
      } catch (e) {
        await reportError(e, message.channel, "CMD_JOINVC");
        await reportInfo(message.channel, "Failed to join/move. Check my permissions (Connect/Speak) and try again.", "VOICE");
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
          await reportInfo(message.channel, "Left the voice channel.", "VOICE");
        } else {
          await reportInfo(message.channel, "Not connected to a voice channel.", "VOICE");
        }
      } catch (e) {
        await reportError(e, message.channel, "CMD_LEAVEVC");
      }
      return;
    }

    // !summarize
    if (rawText.startsWith("!summarize")) {
      if (!channelMeta.summariesEnabled) {
        await reportInfo(message.channel, "Summaries are disabled in this channel.", "SUMMARY");
        return;
      }

      await reportInfo(message.channel, "**Summary in progress…** New messages won’t be considered.", "SUMMARY");

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
          await reportInfo(message.channel, "No messages to summarize yet.", "SUMMARY");
          return;
        }
      } catch (e) {
        await reportError(e, message.channel, "CMD_SUMMARIZE_RUN");
        await reportInfo(message.channel, "Summary failed.", "SUMMARY");
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
          await reportInfo(message.channel, "No summaries available yet.", "SUMMARY");
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
        await reportInfo(message.channel, "RAM context collapsed to: **System + last summary**.", "SUMMARY");
      } catch (e) {
        await reportError(e, message.channel, "CMD_SUMMARIZE_COLLAPSE");
        await reportInfo(message.channel, "RAM context collapse failed (kept full memory).", "SUMMARY");
      }

      try { await reportInfo(message.channel, "**Summary completed.**", "SUMMARY"); } catch {}
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

    // Token limit for chat mode
    const tokenlimit = (() => {
      const raw = (channelMeta.max_tokens_chat ?? channelMeta.maxTokensChat);
      const v = Number(raw);
      const def = 4096;
      return Number.isFinite(v) && v > 0 ? Math.max(32, Math.min(8192, Math.floor(v))) : def;
    })();

    const output = await getAIResponse(
      chatContext,
      tokenlimit,
      1000,
      channelMeta.model || "gpt-4o",
      channelMeta.apikey || null
    );

    if (output && String(output).trim()) {
      await setReplyAsWebhookEmbed(message, output, { botname: channelMeta.botname, color: 0x00b3ff });
      await chatContext.add("assistant", channelMeta?.botname || "AI", output);
    }
  } catch (err) {
    await reportError(err, message?.channel, "ON_MESSAGE_CREATE");
  }
});

// Startup
(async () => {
  try {
    await client.login(process.env.DISCORD_TOKEN);
  } catch (err) {
    reportError(err, null, "LOGIN", { fatal: true });
  }
})();

// NOTE (Discord.js v15 deprecation): use 'clientReady' going forward.
// Keep 'ready' for current compatibility; migrate when upgrading discord.js.
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

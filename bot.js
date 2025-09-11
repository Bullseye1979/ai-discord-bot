// bot.js — refactored v3.16
// Änderungen ggü. v3.14/v3.15:
// - Immer VOR dem KI-Lauf loggen (auch bei Trigger/noTrigger-Bypass).
// - Doppel-Logging verhindert (Flag preLogged).
// - getAIResponse wird mit { pendingUser, noPendingUserInjection: true } aufgerufen.
// - Summarize/Cron weiterhin entfernt.

require('dns').setDefaultResultOrder?.('ipv4first');
const { Client, GatewayIntentBits, PermissionsBitField } = require("discord.js");
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { getAIResponse } = require("./aiCore.js");
const { joinVoiceChannel, getVoiceConnection } = require("@discordjs/voice");
const { hasChatConsent, setChatConsent, setVoiceConsent } = require("./consent.js");
// Cron entfernt
// const { initCron, reloadCronForChannel } = require("./scheduler.js");
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
  setMessageReaction,
} = require("./discord-helper.js");

const { reportError, reportInfo, reportWarn } = require("./error.js");
const { getToolRegistry } = require("./tools.js"); // block toolset

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
const guildTextChannels = new Map();
const voiceBusy = new Map();
const busyNoticeSent = new Map();

// ==== Presence counter ====
let _activeTasks = 0;
function incPresence() {
  _activeTasks++;
  try { setBotPresence(client, "⌛ Working", "online"); } catch {}
}
function decPresence() {
  _activeTasks = Math.max(0, _activeTasks - 1);
  try {
    if (_activeTasks === 0) setBotPresence(client, "✅ Ready", "online");
    else setBotPresence(client, "⌛ Working", "online");
  } catch {}
}

/** Ensure a Context instance for a channel, rebuilding when config signature changes */
function ensureChatContextForChannel(channelId, storage, channelMeta) {
  try {
    const key = `channel:${channelId}`;
    const signature = crypto
      .createHash("sha1")
      .update(
        JSON.stringify({
          persona: channelMeta.persona || "",
          instructions: channelMeta.instructions || "",
          tools: (channelMeta.tools || [])
            .map((t) => t?.function?.name || t?.name || "")
            .sort(),
          botname: channelMeta.botname || "",
          voice: channelMeta.voice || "",
        })
      )
      .digest("hex");

    if (!storage.has(key)) {
      const ctx = new Context(
        channelMeta.persona,
        channelMeta.instructions,
        channelMeta.tools,
        channelMeta.toolRegistry,
        channelId,
        { persistToDB: true }
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
          channelId,
          { persistToDB: true }
        );
        entry.sig = signature;
      }
    }
    return storage.get(key).ctx;
  } catch (err) {
    reportError(err, null, "ENSURE_CHAT_CONTEXT", { emit: "channel" });
    return new Context("", "", [], {}, channelId, { persistToDB: true });
  }
}

/** Check if the first “word” equals a given trigger name (case-insensitive) */
function firstWordEqualsName(text, triggerName) {
  if (!triggerName) return false;
  const t = String(triggerName).trim().toLowerCase();
  const m = String(text || "")
    .trim()
    .match(/^([^\s.,:;!?'"„“‚’«»()[\]{}<>—–-]+)/u);
  const first = (m?.[1] || "").toLowerCase();
  return first === t;
}

/** Strip a leading trigger name (with optional punctuation) from text */
function stripLeadingName(text, triggerName) {
  if (!triggerName) return String(text || "").trim();
  const esc = triggerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `^\\s*${esc}\\s*[.,:;!?'"„“‚’«»()\\[\\]{}<>—–-]*\\s*`,
    "i"
  );
  return String(text || "").replace(re, "").trim();
}

/** Compute a stable signature for a channel meta object */
function metaSig(m) {
  return crypto
    .createHash("sha1")
    .update(
      JSON.stringify({
        persona: m.persona || "",
        instructions: m.instructions || "",
        tools: (m.tools || [])
          .map((t) => t?.function?.name || t?.name || "")
          .sort(),
        botname: m.botname || "",
        voice: m.voice || "",
      })
    )
    .digest("hex");
}

/** Check if a user is an admin for the current channel */
function isChannelAdmin(channelMeta, userId) {
  const ids = Array.isArray(channelMeta.admins)
    ? channelMeta.admins.map(String)
    : [];
  return ids.includes(String(userId));
}

/** Delete all non-pinned messages in a channel (requires permissions) */
async function deleteAllMessages(channel) {
  try {
    const me = channel.guild.members.me;
    const perms = channel.permissionsFor(me);
    if (
      !perms?.has(PermissionsBitField.Flags.ManageMessages) ||
      !perms?.has(PermissionsBitField.Flags.ReadMessageHistory)
    ) {
      throw new Error("Missing permissions: ManageMessages and/or ReadMessageHistory");
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let beforeId = null;

    while (true) {
      const fetched = await channel.messages
        .fetch({ limit: 100, before: beforeId || undefined })
        .catch(() => null);
      if (!fetched || fetched.size === 0) break;

      for (const msg of fetched.values()) {
        if (msg.pinned) continue;
        try { await msg.delete(); } catch {}
        await sleep(120);
      }
      const oldest = fetched.reduce(
        (acc, m) => (acc && acc.createdTimestamp < m.createdTimestamp ? acc : m),
        null
      );
      if (!oldest) break;
      beforeId = oldest.id;
    }
  } catch (err) {
    await reportError(err, channel, "DELETE_ALL_MESSAGES", {
      emit: "channel",
      details: "Failed to clear channel.",
    });
    throw err;
  }
}

/** LLM-Endpunkt/Key/Modell pro Turn auflösen (Block > Global > ENV/Default) */
function resolveEffectiveLLM(channelMeta, matchingBlock) {
  return {
    model: matchingBlock?.model || channelMeta.model || "gpt-4o",
    apikey: matchingBlock?.apikey || channelMeta.apikey || null,
    endpoint:
      matchingBlock?.endpoint ||
      channelMeta.endpoint ||
      process.env.OPENAI_BASE_URL ||
      "https://api.openai.com/v1",
  };
}

/** Voice transcript → AI reply → webhook post → optional TTS (keeps tools; strict busy gate) */
async function handleVoiceTranscriptDirect(evt, client, storage, pendingUserTurn) {
  let ch = null;
  let chatContext = null;
  try {
    ch = await client.channels.fetch(evt.channelId).catch(() => null);
    if (!ch) return;

    if (voiceBusy.get(evt.channelId)) return;

    const channelMeta = getChannelConfig(evt.channelId);
    if (!channelMeta?.hasConfig) return;

    chatContext = ensureChatContextForChannel(evt.channelId, storage, channelMeta);

    if (typeof chatContext.setUserWindow === "function") {
      chatContext.setUserWindow(channelMeta.max_user_messages, { prunePerTwoNonUser: true });
    }

    // Voice-Block nur via SPEAKER (Discord-ID)
    const blocks = Array.isArray(channelMeta.blocks) ? channelMeta.blocks : [];
    const userId = String(evt.userId || "").trim();

    const pickBlockForSpeakerId = () => {
      let exact = null, wildcard = null;
      for (const b of blocks) {
        const sp = Array.isArray(b.speaker)
          ? b.speaker.map((x) => String(x).trim())
          : [];
        if (!sp.length) continue;
        if (sp.includes("*") && !wildcard) wildcard = b;
        if (userId && sp.includes(userId) && !exact) exact = b;
      }
      return exact || wildcard || null;
    };

    const matchingBlock = pickBlockForSpeakerId();
    if (!matchingBlock) return;

    // Tools setzen
    if (matchingBlock && Array.isArray(matchingBlock.tools) && matchingBlock.tools.length > 0) {
      const { tools: blockTools, registry: blockRegistry } = getToolRegistry(matchingBlock.tools);
      chatContext.tools = blockTools;
      chatContext.toolRegistry = blockRegistry;
    } else {
      chatContext.tools = [];
      chatContext.toolRegistry = {};
    }

    const { model: effectiveModel, apikey: effectiveApiKey, endpoint: effectiveEndpoint } =
      resolveEffectiveLLM(channelMeta, matchingBlock);

    const tokenlimit = (() => {
      const raw = channelMeta.max_tokens_speaker ?? channelMeta.maxTokensSpeaker;
      const v = Number(raw);
      const def = 1024;
      return Number.isFinite(v) && v > 0
        ? Math.max(32, Math.min(8192, Math.floor(v)))
        : def;
    })();

    voiceBusy.set(evt.channelId, true);
    incPresence();

    const sequenceLimit = 1;
    const instrBackup = chatContext.instructions;
    try {
      const add = (channelMeta.speechAppend || "").trim();
      if (add) chatContext.instructions = (chatContext.instructions || "") + "\n\n" + add;
    } catch {}

    // 🔴 PRE-LOG (invoked voice): immer vor dem KI-Lauf
    try {
      if (pendingUserTurn && pendingUserTurn.content) {
        await chatContext.add(
          "user",
          pendingUserTurn.name || evt.speaker || "user",
          pendingUserTurn.content,
          pendingUserTurn.timestamp || evt.startedAtMs || Date.now()
        );
      }
    } catch (e) {
      await reportError(e, ch, "VOICE_PRELOG_FAILED", { emit: "channel" });
    }

    let replyText = await getAIResponse(
      chatContext,
      tokenlimit,
      sequenceLimit,
      effectiveModel,
      effectiveApiKey,
      {
        pendingUser: pendingUserTurn || null,
        endpoint: effectiveEndpoint,
        noPendingUserInjection: true, // ⬅︎ WICHTIG: nicht erneut in den Arbeitskontext injizieren
      }
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
      await reportError(e, ch, "VOICE_WEBHOOK_SEND", { emit: "channel" });
      try { await reportInfo(ch, replyText, "FALLBACK"); } catch {}
    }

    try {
      const conn = getVoiceConnection(evt.guildId);
      if (conn) {
        await getSpeech(conn, evt.guildId, replyText, client, channelMeta.voice || "");
      }
    } catch (e) {
      await reportError(e, ch, "VOICE_TTS", { emit: "channel" });
    } finally {
      try { chatContext.instructions = instrBackup; } catch {}
    }
  } catch (err) {
    await reportError(err, ch, "VOICE_TRANSCRIPT_DIRECT", { emit: "channel" });
  } finally {
    try {
      voiceBusy.set(evt.channelId, false);
      busyNoticeSent.delete(evt.channelId);
    } catch {}
    decPresence();
  }
}

client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;

    const baseChannelId = message.channelId;
    const channelMeta = getChannelConfig(baseChannelId);
    if (!channelMeta?.hasConfig) return;

    const key = `channel:${baseChannelId}`;
    const signature = metaSig(channelMeta);

    if (!contextStorage.has(key)) {
      const ctx = new Context(
        channelMeta.persona,
        channelMeta.instructions,
        channelMeta.tools,
        channelMeta.toolRegistry,
        baseChannelId,
        { persistToDB: true }
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
          baseChannelId,
          { persistToDB: true }
        );
        entry.sig = signature;
      }
    }
    const chatContext = contextStorage.get(key).ctx;

    const rawWindow = channelMeta.max_user_messages ?? channelMeta.maxUserMessages ?? null;
    const parsedWindow =
      rawWindow === null || rawWindow === undefined || rawWindow === ""
        ? null
        : Number.isFinite(Number(rawWindow))
        ? Number(rawWindow)
        : null;

    if (typeof chatContext.setUserWindow === "function") {
      chatContext.setUserWindow(parsedWindow, { prunePerTwoNonUser: true });
    }

    const rawText = (message.content || "").trim();
    const isCommand = rawText.startsWith("!");
    const selfIssued = message.author?.id === client.user?.id;

    if (isCommand) {
      if (!channelMeta.hasConfig) return;
      if (!selfIssued && !isChannelAdmin(channelMeta, message.author.id)) {
        return;
      }
    }

    const authorId = String(message.author?.id || "");
    const norm = (rawText || "").toLowerCase();
    const triggerName = (channelMeta.name || "bot").trim().toLowerCase();
    const isTrigger = norm.startsWith(triggerName) || norm.startsWith(`!${triggerName}`);

    // Consent quick-commands
    {
      const lower = rawText.toLowerCase();

      if (lower.startsWith("+consent_chat")) {
        await setChatConsent(authorId, baseChannelId, true);
        await reportInfo(message.channel, "Chat consent saved for this channel.", "CONSENT");
        return;
      }
      if (lower.startsWith("+withdrawl_chat")) {
        await setChatConsent(authorId, baseChannelId, false);
        await reportWarn(message.channel, "Chat consent withdrawn for this channel.", "CONSENT");
        return;
      }
      if (lower.startsWith("+consent_voice")) {
        await setVoiceConsent(authorId, baseChannelId, true);
        await reportInfo(message.channel, "Voice consent saved for this channel.", "CONSENT");
        return;
      }
      if (lower.startsWith("+withdrawl_voice")) {
        await setVoiceConsent(authorId, baseChannelId, false);
        await reportWarn(message.channel, "Voice consent withdrawn for this channel.", "CONSENT");
        return;
      }
    }

    // !clear-channel
    if (rawText.trim() === "!clear-channel") {
      try {
        await deleteAllMessages(message.channel);
        await reportInfo(message.channel, "Channel cleared.", "MAINTENANCE");
      } catch (e) {
        await reportError(e, message.channel, "CMD_CLEAR_CHANNEL", { emit: "channel" });
        await reportInfo(
          message.channel,
          "I lack permissions (Manage Messages + Read Message History).",
          "MAINTENANCE"
        );
      }
      return;
    }

    // !context
    if (rawText.trim() === "!context") {
      const chunks = await chatContext.getContextAsChunks();
      for (const c of chunks) await sendChunked(message.channel, `\`\`\`json\n${c}\n\`\`\``);
      return;
    }

    // !purge-db
    if (rawText.trim() === "!purge-db") {
      try {
        const res = await chatContext.purgeChannelData();
        await reportInfo(
          message.channel,
          `Purged database for this channel.\n- context_log deleted: **${res.contextDeleted}**\n`,
          "MAINTENANCE"
        );
      } catch (e) {
        await reportError(e, message.channel, "CMD_PURGE_DB", { emit: "channel" });
        await reportInfo(message.channel, "Failed to purge database entries for this channel.", "MAINTENANCE");
      }
      return;
    }

    // !joinvc
    if (rawText.trim() === "!joinvc") {
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
        await reportInfo(
          message.channel,
          `Connected to **${vc.name}**. Transcripts & TTS are now bound here.`,
          "VOICE"
        );

        // voice listener
        setStartListening(conn, message.guild.id, guildTextChannels, client, async (evt) => {
          try {
            const channelMeta = getChannelConfig(evt.channelId);
            if (!channelMeta?.hasConfig) return;

            const chatContext = ensureChatContextForChannel(evt.channelId, contextStorage, channelMeta);

            if (typeof chatContext.setUserWindow === "function") {
              chatContext.setUserWindow(channelMeta.max_user_messages, { prunePerTwoNonUser: true });
            }

            const TRIGGER = (channelMeta.name || "").trim();

            const blocks = Array.isArray(channelMeta.blocks) ? channelMeta.blocks : [];
            const userId = String(evt.userId || "").trim();

            const voiceBlock = (() => {
              let exact = null, wildcard = null;
              for (const b of blocks) {
                const sp = Array.isArray(b.speaker) ? b.speaker.map((x) => String(x).trim()) : [];
                if (!sp.length) continue;
                if (sp.includes("*") && !wildcard) wildcard = b;
                if (userId && sp.includes(userId) && !exact) exact = b;
              }
              return exact || wildcard || null;
            })();

            const bypassTrigger = !!voiceBlock && voiceBlock.noTrigger === true;
            const invoked = !!voiceBlock && (bypassTrigger || firstWordEqualsName(evt.text, TRIGGER));

            // Nicht-invoked → nur loggen und fertig
            if (!invoked) {
              try {
                await chatContext.add(
                  "user",
                  evt.speaker || "voice",
                  String(evt.text || "").trim(),
                  evt.startedAtMs || Date.now()
                );
              } catch (e) {
                await reportError(e, null, "VOICE_LOG_CONTEXT_NONINVOKED", { emit: "channel" });
              }
              return;
            }

            if (voiceBusy.get(evt.channelId)) {
              if (!busyNoticeSent.get(evt.channelId)) {
                const ch = await client.channels.fetch(evt.channelId).catch(() => null);
                if (ch) {
                  await reportWarn(
                    ch,
                    "I’m already answering someone. Please wait until I finish speaking — then try again. Thanks for your patience! 😊",
                    "BUSY"
                  );
                  busyNoticeSent.set(evt.channelId, true);
                }
              }
              return;
            }

            const textForLog = stripLeadingName(evt.text, TRIGGER);
            const pendingUserTurn = {
              name: evt.speaker || "user",
              content: (textForLog || "").trim(),
              timestamp: evt.startedAtMs || Date.now(),
            };

            await handleVoiceTranscriptDirect({ ...evt, text: textForLog }, client, contextStorage, pendingUserTurn);
            busyNoticeSent.delete(evt.channelId);
          } catch (err) {
            await reportError(err, null, "VOICE_LISTENING_CALLBACK", { emit: "channel" });
          }
        });
      } catch (e) {
        await reportError(e, message.channel, "CMD_JOINVC", { emit: "channel" });
        await reportInfo(message.channel, "Failed to join/move. Check my permissions (Connect/Speak) and try again.", "VOICE");
      }
      return;
    }

    // !leavevc
    if (rawText.trim() === "!leavevc") {
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
        await reportError(e, message.channel, "CMD_LEAVEVC", { emit: "channel" });
      }
      return;
    }

    // =========================
    // Normal flow: typed chat
    // =========================
    if (message.author?.bot || message.webhookId) return;
    const hasConsent = await hasChatConsent(authorId, baseChannelId);
    if (!hasConsent) return;

    // Pre-log immer, aber ohne Doppel-Logging
    let preLogged = false;
    if (!isTrigger) {
      await setAddUserMessage(message, chatContext); // bewährt für non-trigger
      preLogged = true;
    }

    // Block selection for typed chat — STRICTLY by user id (with wildcard)
    const blocks = Array.isArray(channelMeta.blocks) ? channelMeta.blocks : [];
    const pickBlockForUser = () => {
      let exact = null, wildcard = null;
      for (const b of blocks) {
        const us = Array.isArray(b.user) ? b.user.map(x => String(x).trim()) : [];
        if (!us.length) continue;
        if (us.includes("*") && !wildcard) wildcard = b;
        if (authorId && us.includes(authorId) && !exact) exact = b;
      }
      return exact || wildcard || null;
    };
    const matchingBlock = pickBlockForUser();
    if (!matchingBlock) return;

    const bypassTrigger = matchingBlock.noTrigger === true;
    if (!bypassTrigger && !isTrigger) return;

    // Falls Trigger/noTrigger -> ggf. noch nicht geloggt → jetzt loggen
    const textForLog = stripLeadingName(rawText, triggerName);
    if (!preLogged) {
      try {
        await chatContext.add(
          "user",
          message.member?.displayName || message.author?.username || "user",
          (textForLog || "").trim(),
          message.createdTimestamp || Date.now()
        );
        preLogged = true;
      } catch (e) {
        await reportError(e, message?.channel, "CHAT_PRELOG_FAILED", { emit: "channel" });
      }
    }

    await setMessageReaction(message, "⏳");
    incPresence();

    // Tools setzen (Block-spezifisch, sonst global)
    if (matchingBlock && Array.isArray(matchingBlock.tools) && matchingBlock.tools.length > 0) {
      const { tools: blockTools, registry: blockRegistry } = getToolRegistry(matchingBlock.tools);
      chatContext.tools = blockTools;
      chatContext.toolRegistry = blockRegistry;
    } else {
      chatContext.tools = channelMeta.tools;
      chatContext.toolRegistry = channelMeta.toolRegistry;
    }

    const { model: effectiveModel, apikey: effectiveApiKey, endpoint: effectiveEndpoint } =
      resolveEffectiveLLM(channelMeta, matchingBlock);

    const tokenlimit = (() => {
      const raw = channelMeta.max_tokens_chat ?? channelMeta.maxTokensChat;
      const v = Number(raw);
      const def = 4096;
      return Number.isFinite(v) && v > 0
        ? Math.max(32, Math.min(8192, Math.floor(v)))
        : def;
    })();

    const instrBackup = chatContext.instructions;
    try {
      const add = (channelMeta.chatAppend || "").trim();
      if (add) chatContext.instructions = (chatContext.instructions || "") + "\n\n" + add;
    } catch {}

    try {
      const pendingUserTurn = {
        name: message.member?.displayName || message.author?.username || "user",
        content: (textForLog || "").trim(),
        timestamp: message.createdTimestamp || Date.now(),
      };

      const output = await getAIResponse(
        chatContext,
        tokenlimit,
        1000,
        effectiveModel,
        effectiveApiKey,
        {
          pendingUser: pendingUserTurn,
          endpoint: effectiveEndpoint,
          noPendingUserInjection: true // ⬅︎ nicht erneut in den Arbeitskontext injizieren
        }
      );

      if (output && String(output).trim()) {
        await setReplyAsWebhookEmbed(message, output, {
          botname: channelMeta.botname,
          color: 0x00b3ff,
        });
        await chatContext.add("assistant", channelMeta?.botname || "AI", output);
        await setMessageReaction(message, "✅");
      } else {
        await reportInfo(message.channel, "No output produced.", "AI");
        await setMessageReaction(message, "❌");
      }
    } catch (err) {
      await reportError(err, message?.channel, "ON_MESSAGE_CREATE_TYPED", { emit: "channel" });
      try { await setMessageReaction(message, "❌"); } catch {}
    } finally {
      try { chatContext.instructions = instrBackup; } catch {}
      decPresence();
    }
  } catch (err) {
    await reportError(err, message?.channel, "ON_MESSAGE_CREATE", { emit: "channel" });
  }
});

// ==== Ready handler (deprecation-safe) ====
function onClientReadyOnce() {
  if (onClientReadyOnce._ran) return;
  onClientReadyOnce._ran = true;
  try {
    setBotPresence(client, "✅ Ready", "online");
    // Cron entfernt
  } catch (err) {
    reportError(err, null, "READY_INIT", { emit: "channel" });
  }
}
client.once("clientReady", onClientReadyOnce);

// ==== Startup ====
(async () => {
  try {
    await client.login(process.env.DISCORD_TOKEN);
  } catch (err) {
    reportError(err, null, "LOGIN", { emit: "channel" });
  }
})();

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

// bot.js — refactored v3.11 (typed tool-calls restored, per-message reactions, presence, one-shot BUSY gate, tool-flow commit)
// Commands: !context, !summarize, !purge-db, !joinvc, !leavevc. Voice transcripts → AI reply + TTS. Cron support. Static /documents.

require('dns').setDefaultResultOrder?.('ipv4first');
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
const guildTextChannels = new Map();    // guildId -> textChannelId (for TTS/transcripts)
const voiceBusy = new Map();            // channelId -> boolean (busy while LLM+TTS runs)
const busyNoticeSent = new Map();       // channelId -> boolean (BUSY notice already shown during this busy period)

// ==== Presence counter (⏳ while >0 active tasks; ✅ when idle) ====
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
          summaryPrompt: channelMeta.summaryPrompt || "",
        })
      )
      .digest("hex");

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
    reportError(err, null, "ENSURE_CHAT_CONTEXT", { emit: "channel" });
    return new Context("", "", [], {}, channelId);
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
        summaryPrompt: m.summaryPrompt || "",
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
      throw new Error(
        "Missing permissions: ManageMessages and/or ReadMessageHistory"
      );
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
        try {
          await msg.delete();
        } catch {}
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

/** Voice transcript → AI reply → webhook post → optional TTS (keeps tools; strict busy gate) */
async function handleVoiceTranscriptDirect(evt, client, storage, pendingUserTurn) {
  let ch = null;
  let chatContext = null;
  try {
    ch = await client.channels.fetch(evt.channelId).catch(() => null);
    if (!ch) return;

    // If already busy, ignore silently — the BUSY notice is sent in the listener once per busy period.
    if (voiceBusy.get(evt.channelId)) return;

    const channelMeta = getChannelConfig(evt.channelId);
    chatContext = ensureChatContextForChannel(evt.channelId, storage, channelMeta);

    if (typeof chatContext.setUserWindow === "function") {
      chatContext.setUserWindow(channelMeta.max_user_messages, {
        prunePerTwoNonUser: true,
      });
    }

    // Block selection for voice (speaker OR user id)
    const blocks = Array.isArray(channelMeta.blocks) ? channelMeta.blocks : [];
    const speakerNameLower = String(evt.speaker || "").trim().toLowerCase();
    const userId = String(evt.userId || "").trim();

    const pickBlockForSpeaker = () => {
      let exact = null,
        wildcard = null;
      for (const b of blocks) {
        const sp = Array.isArray(b.speaker)
          ? b.speaker.map((s) => String(s).trim().toLowerCase())
          : [];
        if (!sp.length) continue;
        if (sp.includes("*") && !wildcard) wildcard = b;
        if (speakerNameLower && sp.includes(speakerNameLower) && !exact)
          exact = b;
      }
      return exact || wildcard || null;
    };
    const pickBlockForUser = () => {
      let exact = null,
        wildcard = null;
      for (const b of blocks) {
        const us = Array.isArray(b.user)
          ? b.user.map((x) => String(x).trim())
          : [];
        if (!us.length) continue;
        if (us.includes("*") && !wildcard) wildcard = b;
        if (userId && us.includes(userId) && !exact) exact = b;
      }
      return exact || wildcard || null;
    };

    const matchingBlock = pickBlockForSpeaker() || pickBlockForUser();

    let effectiveModel = matchingBlock?.model || channelMeta.model || undefined;
    let effectiveApiKey = matchingBlock?.apikey || channelMeta.apikey || null;

    if (
      matchingBlock &&
      Array.isArray(matchingBlock.tools) &&
      matchingBlock.tools.length > 0
    ) {
      const { tools: blockTools, registry: blockRegistry } = getToolRegistry(
        matchingBlock.tools
      );
      chatContext.tools = blockTools;
      chatContext.toolRegistry = blockRegistry;
    } else {
      chatContext.tools = channelMeta.tools;
      chatContext.toolRegistry = channelMeta.toolRegistry;
    }

    const tokenlimit = (() => {
      const raw = channelMeta.max_tokens_speaker ?? channelMeta.maxTokensSpeaker;
      const v = Number(raw);
      const def = 1024;
      return Number.isFinite(v) && v > 0
        ? Math.max(32, Math.min(8192, Math.floor(v)))
        : def;
    })();

    // mark busy + presence *before* any await — ensures strict gating + presence
    voiceBusy.set(evt.channelId, true);
    incPresence();

    const sequenceLimit = 1;
    const instrBackup = chatContext.instructions;
    try {
      const add = (channelMeta.speechAppend || "").trim();
      if (add)
        chatContext.instructions =
          (chatContext.instructions || "") + "\n\n" + add;
    } catch {}

    let replyText = await getAIResponse(
      chatContext,
      tokenlimit,
      sequenceLimit,
      effectiveModel,
      effectiveApiKey,
      { pendingUser: pendingUserTurn } // pass pending user-turn for working copy + commit after
    );
    replyText = (replyText || "").trim();
    if (!replyText) return;

    try {
      await chatContext.add(
        "assistant",
        channelMeta.botname || "AI",
        replyText,
        Date.now()
      );
    } catch {}

    try {
      const msgShim = { channel: ch };
      await setReplyAsWebhookEmbed(msgShim, replyText, {
        botname: channelMeta.botname || "AI",
      });
    } catch (e) {
      await reportError(e, ch, "VOICE_WEBHOOK_SEND", { emit: "channel" });
      try {
        await reportInfo(ch, replyText, "FALLBACK");
      } catch {}
    }

    try {
      const conn = getVoiceConnection(evt.guildId);
      if (conn) {
        await getSpeech(
          conn,
          evt.guildId,
          replyText,
          client,
          channelMeta.voice || ""
        );
      }
    } catch (e) {
      await reportError(e, ch, "VOICE_TTS", { emit: "channel" });
    } finally {
      try {
        chatContext.instructions = instrBackup;
      } catch {}
    }
  } catch (err) {
    await reportError(err, ch, "VOICE_TRANSCRIPT_DIRECT", { emit: "channel" });
  } finally {
    // End of busy period → allow next voice, reset the one-shot BUSY flag, presence --
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

    const rawWindow =
      channelMeta.max_user_messages ?? channelMeta.maxUserMessages ?? null;
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
      if (!channelMeta.hasConfig) {
        await reportInfo(
          message.channel,
          "Commands are disabled in channels without a channel-config file.",
          "COMMANDS"
        );
        return;
      }
      if (!selfIssued && !isChannelAdmin(channelMeta, message.author.id)) {
        await reportInfo(
          message.channel,
          "You are not authorized to run commands in this channel.",
          "COMMANDS"
        );
        return;
      }
    }

    // We only store non-trigger normal chat into context immediately.
    // Triggered AI turns will be passed as pendingUser to getAIResponse and committed after tools finish.
    const authorId = String(message.author?.id || "");
    const norm = (rawText || "").toLowerCase();
    const triggerName = (channelMeta.name || "bot").trim().toLowerCase();
    const isTrigger = norm.startsWith(triggerName) || norm.startsWith(`!${triggerName}`);

    if (!isCommand && !isTrigger && !message.author?.bot && !message.webhookId) {
      await setAddUserMessage(message, chatContext);
    }

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

    // !clear-channel / !purge-channel
    if (rawText.startsWith("!clear-channel") || rawText.startsWith("!purge-channel")) {
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

    // !context (view only)
    if (rawText.startsWith("!context")) {
      const chunks = await chatContext.getContextAsChunks();
      for (const c of chunks)
        await sendChunked(message.channel, `\`\`\`json\n${c}\n\`\`\``);
      return;
    }

    // !reload-cron
    if (rawText.startsWith("!reload-cron")) {
      try {
        const ok = await reloadCronForChannel(client, contextStorage, baseChannelId);
        await reportInfo(
          message.channel,
          ok ? "Cron reloaded for this channel." : "No crontab defined for this channel.",
          "CRON"
        );
      } catch (e) {
        await reportError(e, message.channel, "CMD_RELOAD_CRON", { emit: "channel" });
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
        await reportError(e, message.channel, "CMD_PURGE_DB", { emit: "channel" });
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
        await reportInfo(
          message.channel,
          `Connected to **${vc.name}**. Transcripts & TTS are now bound here.`,
          "VOICE"
        );

        // voice listener
        setStartListening(conn, message.guild.id, guildTextChannels, client, async (evt) => {
          try {
            const channelMeta = getChannelConfig(evt.channelId);
            const chatContext = ensureChatContextForChannel(evt.channelId, contextStorage, channelMeta);

            if (typeof chatContext.setUserWindow === "function") {
              chatContext.setUserWindow(channelMeta.max_user_messages, { prunePerTwoNonUser: true });
            }

            const TRIGGER = (channelMeta.name || "").trim();
            const invoked = firstWordEqualsName(evt.text, TRIGGER);
            if (!invoked) return;

            // Strict busy gate:
            if (voiceBusy.get(evt.channelId)) {
              if (!busyNoticeSent.get(evt.channelId)) {
                const ch = await client.channels.fetch(evt.channelId).catch(() => null);
                if (ch) {
                  await reportWarn(
                    ch,
                    "I’m already answering someone. Please wait until I finish speaking — then try again. Thanks for your patience! 😊",
                    "BUSY"
                  );
                  busyNoticeSent.set(evt.channelId, true); // one-shot during this busy period
                }
              }
              return; // do NOT log this utterance, do NOT queue anything
            }

            // Not busy → prepare pending user-turn (do NOT write to context yet)
            const textForLog = stripLeadingName(evt.text, TRIGGER);
            const pendingUserTurn = {
              name: evt.speaker || "user",
              content: (textForLog || "").trim(),
              timestamp: evt.startedAtMs || Date.now(),
            };

            // run the full voice pipeline (sets busy/presence and commits after tools finish)
            await handleVoiceTranscriptDirect({ ...evt, text: textForLog }, client, contextStorage, pendingUserTurn);

            // one-shot notice is reset at end of busy period (also in finally of handler)
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
        await reportError(e, message.channel, "CMD_LEAVEVC", { emit: "channel" });
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
          await setReplyAsWebhookEmbed(
            message,
            "No messages to summarize yet.",
            { botname: channelMeta.botname, color: 0x00b3ff }
          );
          return;
        }
      } catch (e) {
        await reportError(e, message.channel, "CMD_SUMMARIZE_RUN", { emit: "channel" });
        await reportInfo(message.channel, "Summary failed.", "SUMMARY");
        return;
      }

      try {
        // Fetch & render summaries as Persona via webhook embed:
        const last5Desc = await chatContext.getLastSummaries(5);
        const summariesAsc = (last5Desc || []).slice().reverse();

        if (summariesAsc.length === 0) {
          await setReplyAsWebhookEmbed(
            message,
            "No summaries available yet.",
            { botname: channelMeta.botname, color: 0x00b3ff }
          );
        } else {
          const combined = summariesAsc
            .map((r, i) => `**Summary ${i + 1}/${summariesAsc.length} — ${new Date(r.timestamp).toLocaleString()}**\n${r.summary}`)
            .join("\n\n");

          await setReplyAsWebhookEmbed(
            message,
            combined,
            { botname: channelMeta.botname, color: 0x00b3ff }
          );
        }
      } catch (e) {
        await reportError(e, message.channel, "CMD_SUMMARIZE_POST", { emit: "channel" });
      }

      try { await chatContext.bumpCursorToCurrentMax(); } catch (e) {
        await reportError(e, message.channel, "CMD_SUMMARIZE_BUMP");
      }

      try {
        await chatContext.collapseToSystemAndLastSummary();
      } catch (e) {
        await reportError(e, message.channel, "CMD_SUMMARIZE_COLLAPSE", { emit: "channel" });
        await reportInfo(message.channel, "RAM context collapse failed (kept full memory).", "SUMMARY");
      }

      try { await reportInfo(message.channel, "**Summary completed.**", "SUMMARY"); } catch {}
      return;
    }

    // Normal flow: explicit trigger (typed chat)
    if (message.author?.bot || message.webhookId) return;
    const hasConsent = await hasChatConsent(authorId, baseChannelId);
    if (!hasConsent) return;

    if (!isTrigger) return;

    // Reactions + presence
    await setMessageReaction(message, "⏳");
    incPresence();

    // Block selection for typed chat — by user id
    let effectiveModel = channelMeta.model || "gpt-4o";
    let effectiveApiKey = channelMeta.apikey || null;

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

    if (matchingBlock && Array.isArray(matchingBlock.tools) && matchingBlock.tools.length > 0) {
      const { tools: blockTools, registry: blockRegistry } = getToolRegistry(matchingBlock.tools);
      chatContext.tools = blockTools;
      chatContext.toolRegistry = blockRegistry;
    } else {
      chatContext.tools = channelMeta.tools;
      chatContext.toolRegistry = channelMeta.toolRegistry;
    }
    if (matchingBlock?.model)  effectiveModel  = matchingBlock.model;
    if (matchingBlock?.apikey) effectiveApiKey = matchingBlock.apikey;

    const tokenlimit = (() => {
      const raw = channelMeta.max_tokens_chat ?? channelMeta.maxTokensChat;
      const v = Number(raw);
      const def = 4096;
      return Number.isFinite(v) && v > 0
        ? Math.max(32, Math.min(8192, Math.floor(v)))
        : def;
    })();

    // typed: use chatAppend only
    const instrBackup = chatContext.instructions;
    try {
      const add = (channelMeta.chatAppend || "").trim();
      if (add) chatContext.instructions = (chatContext.instructions || "") + "\n\n" + add;
    } catch {}

    try {
      const textForLog = stripLeadingName(rawText, triggerName);
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
        { pendingUser: pendingUserTurn }
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
    initCron(client, contextStorage);
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

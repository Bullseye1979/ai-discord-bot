// discord-handler.js — refactored v2.11
// Discord AI flow: routing to AI, token limits, tool setup, voice join, and gated TTS playback.

const { joinVoiceChannel, getVoiceConnection } = require("@discordjs/voice");
const {
  setMessageReaction,
  getChannelConfig,
  setReplyAsWebhookEmbed,
  getSpeech,
} = require("./discord-helper.js");
const { getAIResponse } = require("./aiCore.js");
const { getToolRegistry } = require("./tools.js");
const { reportError, reportInfo } = require("./error.js");

// TTS gate per channel (enabled temporarily after voice-triggered input)
const ttsGate = new Map();
const TTS_TTL_MS = 15000;

/** Temporarily allow TTS for a channel */
function markTTSAllowedForChannel(channelId, ttlMs = TTS_TTL_MS) {
  if (!channelId) return;
  const expires = Date.now() + ttlMs;
  ttsGate.set(String(channelId), expires);
  setTimeout(() => {
    const cur = ttsGate.get(String(channelId));
    if (cur && cur <= Date.now()) ttsGate.delete(String(channelId));
  }, ttlMs + 1000);
}

/** Run a full AI request for a Discord message (tools, limits, instructions, reply & logging) */
async function getProcessAIRequest(message, chatContext, client, state, model, apiKey) {
  let _instrBackup = chatContext.instructions;
  try {
    if (state.isAIProcessing >= 3) {
      await setMessageReaction(message, "❌");
      return;
    }
    state.isAIProcessing++;

    await setMessageReaction(message, "⏳");

    const channelMeta = getChannelConfig(message.channelId);
    if (!channelMeta) {
      await setMessageReaction(message, "❌");
      return;
    }

    const blocks = Array.isArray(channelMeta.blocks) ? channelMeta.blocks : [];
    const isSpeakerMsg = !!message.webhookId;

    // Token limit per mode (speaker vs chat) with clamps
    const tokenlimit = (() => {
      const raw = isSpeakerMsg
        ? (channelMeta.max_tokens_speaker ?? channelMeta.maxTokensSpeaker)
        : (channelMeta.max_tokens_chat    ?? channelMeta.maxTokensChat);
      const v = Number(raw);
      const def = isSpeakerMsg ? 1024 : 4096;
      return Number.isFinite(v) && v > 0 ? Math.max(32, Math.min(8192, Math.floor(v))) : def;
    })();

    // Disable auto-continue for speaker mode
    const sequenceLimit = isSpeakerMsg ? 1 : 1000;

    // Effective channel id (threads → parent)
    const inThread = typeof message.channel.isThread === "function" ? message.channel.isThread() : false;
    const effectiveChannelId = inThread ? (message.channel.parentId || message.channel.id) : message.channel.id;

    // If speaker-triggered (voice), allow TTS for a short time window on this channel
    if (isSpeakerMsg) markTTSAllowedForChannel(effectiveChannelId);

    // Block matching
    const speakerName = (message.member?.displayName || message.author?.username || "").trim().toLowerCase();
    const userId = String(message.author?.id || "").trim();

    function pickBlockForSpeaker() {
      let exact = null, wildcard = null;
      for (const b of blocks) {
        const sp = Array.isArray(b.speaker) ? b.speaker.map(s => String(s).trim().toLowerCase()) : [];
        if (!sp.length) continue;
        if (sp.includes("*") && !wildcard) wildcard = b;
        if (speakerName && sp.includes(speakerName) && !exact) exact = b;
      }
      return exact || wildcard || null;
    }

    function pickBlockForUser() {
      let exact = null, wildcard = null;
      for (const b of blocks) {
        const us = Array.isArray(b.user) ? b.user.map(x => String(x).trim()) : [];
        if (!us.length) continue;
        if (us.includes("*") && !wildcard) wildcard = b;
        if (userId && us.includes(userId) && !exact) exact = b;
      }
      return exact || wildcard || null;
    }

    const matchingBlock = isSpeakerMsg ? pickBlockForSpeaker() : pickBlockForUser();
    if (!matchingBlock) { await setMessageReaction(message, "❌"); return; }

    const effectiveModel  = matchingBlock.model  || model;
    const effectiveApiKey = matchingBlock.apikey || apiKey;

    // Tool selection (block overrides channel)
    if (Array.isArray(matchingBlock.tools) && matchingBlock.tools.length > 0) {
      const { tools: blockTools, registry: blockRegistry } = getToolRegistry(matchingBlock.tools);
      chatContext.tools = blockTools;
      chatContext.toolRegistry = blockRegistry;
    } else {
      chatContext.tools = channelMeta.tools;
      chatContext.toolRegistry = channelMeta.toolRegistry;
    }

    // Strict guard if no summaries exist
    const lastSumm = await chatContext.getLastSummaries(1).catch(() => []);
    if (!Array.isArray(lastSumm) || lastSumm.length === 0) {
      _instrBackup = chatContext.instructions;
      chatContext.instructions = (_instrBackup || "") +
        "\n\n[STRICT RULE] There is no existing conversation summary. Do not assume one. " +
        "Base your answer only on the visible messages. If asked about a past summary, say there is none yet.";
    }

    // Auto-append image URLs found in user attachments (non-webhook messages)
    const imageUrls = [];
    if (!message.webhookId && message.attachments?.size > 0) {
      for (const att of message.attachments.values()) {
        const ct = (att.contentType || att.content_type || "").toLowerCase();
        const isImageCT  = ct.startsWith("image/");
        const isImageExt = /\.(png|jpe?g|webp|gif|bmp)$/i.test(att.name || att.filename || att.url || "");
        if ((isImageCT || isImageExt) && att.url) imageUrls.push(att.url);
      }
    }

    if (imageUrls.length) {
      const hasGetImageTool =
        Array.isArray(chatContext.tools) &&
        chatContext.tools.some(t => (t.function?.name || t.name) === "getImage");
      const hint =
        "\n\n[IMAGE UPLOAD]\n" +
        imageUrls.map(u => `- ${u}`).join("\n") +
        "\nTask: Describe what is shown in these images." +
        (hasGetImageTool ? " You may use the `getImage` tool." : "");
      chatContext.instructions = (chatContext.instructions || "") + hint;
    }

    // Mode-specific instruction append (chat vs speech)
    const channelMetaFull = getChannelConfig(effectiveChannelId);
    const modeAppend = (isSpeakerMsg ? channelMetaFull.speechAppend : channelMetaFull.chatAppend) || "";
    if (modeAppend.trim()) {
      chatContext.instructions = (chatContext.instructions || "") + "\n\n" + modeAppend.trim();
    }

    // AI call
    const output = await getAIResponse(
      chatContext,
      tokenlimit,
      sequenceLimit,
      effectiveModel,
      effectiveApiKey
    );

    if (output && String(output).trim()) {
      await setReplyAsWebhookEmbed(message, output, {
        botname: channelMetaFull.botname,
        color: 0x00b3ff,
      });
      await chatContext.add("assistant", channelMetaFull?.botname || "AI", output);
      await setMessageReaction(message, "✅");
    } else {
      await setMessageReaction(message, "❌");
    }
  } catch (err) {
    await reportError(err, message?.channel, "PROCESS_AI_REQUEST");
    try { await setMessageReaction(message, "❌"); } catch {}
  } finally {
    try {
      if (typeof _instrBackup === "string") chatContext.instructions = _instrBackup;
    } catch {}
    state.isAIProcessing--;
  }
}

/** Join the caller’s voice channel and remember the associated text channel */
async function setVoiceChannel(message, guildTextChannels) {
  try {
    const channel = message.member?.voice?.channel;
    if (!channel) {
      await reportInfo(message.channel, "❌ Join a voice channel first, then run `!joinvc`.", "SET_VOICE_CHANNEL");
      return;
    }

    joinVoiceChannel({
      channelId: channel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    guildTextChannels.set(message.guild.id, message.channel.id);
    await reportInfo(message.channel, `🔊 Joined **${channel.name}**. TTS ready.`, "SET_VOICE_CHANNEL");
  } catch (err) {
    await reportError(err, message?.channel, "SET_VOICE_CHANNEL");
  }
}

/** Speak AI webhook replies via TTS if the channel is temporarily allowed for TTS */
async function setTTS(message, client, guildTextChannels) {
  try {
    if (!message.guild) return;

    const inThread = typeof message.channel.isThread === "function" ? message.channel.isThread() : false;
    if (inThread && message.channel.name === "Transcripts") return;

    const txt = (message.content || "").trim();
    const looksLikeSummary =
      txt.startsWith("**Summary") ||
      txt.includes("Summary in progress…") ||
      txt.includes("Summary completed.");
    if (looksLikeSummary) return;

    const isWebhook = !!message.webhookId;
    const effectiveChannelId = inThread ? (message.channel.parentId || message.channel.id) : message.channel.id;
    const meta = getChannelConfig(effectiveChannelId);

    const isAIWebhook =
      isWebhook &&
      (await message.channel.fetchWebhooks()
        .then(ws => {
          const w = ws.find(x => x.id === message.webhookId);
          return w && w.name === (meta?.botname || "AI");
        })
        .catch(() => false));

    if (!isAIWebhook) return;

    const gate = ttsGate.get(String(effectiveChannelId));
    if (!gate || gate < Date.now()) return;

    const guildId = message.guild.id;
    const expectedChannelId = guildTextChannels.get(guildId);
    if (expectedChannelId && message.channel.id !== expectedChannelId) return;

    const connection = getVoiceConnection(guildId);
    if (!connection) return;

    const cleaned = txt
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "Link")
      .replace(/<@!?(\d+)>/g, "someone")
      .replace(/:[^:\s]+:/g, "");

    if (cleaned) {
      await getSpeech(connection, guildId, cleaned, client, meta?.voice);
    }
  } catch (err) {
    await reportError(err, message?.channel, "SET_TTS");
  }
}

module.exports = {
  getProcessAIRequest,
  setVoiceChannel,
  setTTS,
};

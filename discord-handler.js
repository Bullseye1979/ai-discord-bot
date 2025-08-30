// discord-handler.js — refactored v3.4 (chat tools fixed: unified block match + fallback, info via error.js)
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

function markTTSAllowedForChannel(channelId, ttlMs = TTS_TTL_MS) {
  if (!channelId) return;
  const expires = Date.now() + ttlMs;
  ttsGate.set(String(channelId), expires);
  setTimeout(() => {
    const cur = ttsGate.get(String(channelId));
    if (cur && cur <= Date.now()) ttsGate.delete(String(channelId));
  }, ttlMs + 1000);
}

async function getProcessAIRequest(message, chatContext, client, state, model, apiKey) {
  let _instrBackup = chatContext.instructions;
  try {
    if (state.isAIProcessing >= 3) {
      await setMessageReaction(message, "❌");
      await reportInfo(message.channel, "Too many concurrent requests. Please wait a moment.", "THROTTLE");
      return;
    }
    state.isAIProcessing++;

    await setMessageReaction(message, "⏳");

    const channelMeta = getChannelConfig(message.channelId);
    if (!channelMeta) {
      await setMessageReaction(message, "❌");
      await reportInfo(message.channel, "No channel config found.", "CONFIG");
      return;
    }

    const blocks = Array.isArray(channelMeta.blocks) ? channelMeta.blocks : [];
    const isSpeakerMsg = !!message.webhookId;

    const tokenlimit = (() => {
      const raw = isSpeakerMsg
        ? (channelMeta.max_tokens_speaker ?? channelMeta.maxTokensSpeaker)
        : (channelMeta.max_tokens_chat    ?? channelMeta.maxTokensChat);
      const v = Number(raw);
      const def = isSpeakerMsg ? 1024 : 4096;
      return Number.isFinite(v) && v > 0 ? Math.max(32, Math.min(8192, Math.floor(v))) : def;
    })();

    const sequenceLimit = isSpeakerMsg ? 1 : 1000;

    const inThread = typeof message.channel.isThread === "function" ? message.channel.isThread() : false;
    const effectiveChannelId = inThread ? (message.channel.parentId || message.channel.id) : message.channel.id;

    if (isSpeakerMsg) markTTSAllowedForChannel(effectiveChannelId);

    // --- Unified block matching: try user → speaker → wildcard, else fallback to channel tools/model
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

    const byUser = pickBlockForUser();
    const bySpeaker = pickBlockForSpeaker();
    const wildcard = blocks.find(b =>
      (Array.isArray(b.user) && b.user.includes("*")) ||
      (Array.isArray(b.speaker) && b.speaker.includes("*"))
    ) || null;

    // If this is a text message, prefer user match; if voice/webhook, prefer speaker match.
    const matchingBlock = (isSpeakerMsg ? (bySpeaker || byUser || wildcard) : (byUser || bySpeaker || wildcard)) || null;

    // Effective model/apikey; tools come from block if present, else from channel config.
    const effectiveModel  = (matchingBlock?.model  || model);
    const effectiveApiKey = (matchingBlock?.apikey || apiKey);

    if (matchingBlock && Array.isArray(matchingBlock.tools) && matchingBlock.tools.length > 0) {
      const { tools: blockTools, registry: blockRegistry } = getToolRegistry(matchingBlock.tools);
      chatContext.tools = blockTools;
      chatContext.toolRegistry = blockRegistry;
    } else {
      chatContext.tools = channelMeta.tools;
      chatContext.toolRegistry = channelMeta.toolRegistry;
    }
    // --- /Unified block matching

    const lastSumm = await chatContext.getLastSummaries(1).catch(() => []);
    if (!Array.isArray(lastSumm) || lastSumm.length === 0) {
      _instrBackup = chatContext.instructions;
      chatContext.instructions = (_instrBackup || "") +
        "\n\n[STRICT RULE] There is no existing conversation summary. Do not assume one. " +
        "Base your answer only on the visible messages. If asked about a past summary, say there is none yet.";
    }

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

    const modeAppend = (isSpeakerMsg ? channelMeta.speechAppend : channelMeta.chatAppend) || "";
    if (modeAppend.trim()) {
      chatContext.instructions = (chatContext.instructions || "") + "\n\n" + modeAppend.trim();
    }

    const output = await getAIResponse(
      chatContext,
      tokenlimit,
      sequenceLimit,
      effectiveModel,
      effectiveApiKey
    );

    if (output && String(output).trim()) {
      await setReplyAsWebhookEmbed(message, output, {
        botname: channelMeta.botname,
        color: 0x00b3ff,
      });
      await chatContext.add("assistant", channelMeta?.botname || "AI", output);
      await setMessageReaction(message, "✅");
    } else {
      await setMessageReaction(message, "❌");
      await reportInfo(message.channel, "No output produced.", "AI");
    }
  } catch (err) {
    await reportError(err, message?.channel, "PROCESS_AI_REQUEST", { emit: "channel" });
    try { await setMessageReaction(message, "❌"); } catch {}
  } finally {
    try {
      if (typeof _instrBackup === "string") chatContext.instructions = _instrBackup;
    } catch {}
    state.isAIProcessing--;
  }
}

async function setVoiceChannel(message, guildTextChannels) {
  try {
    const channel = message.member?.voice?.channel;
    if (!channel) {
      await reportInfo(message.channel, "Join a voice channel first, then run `!joinvc`.", "VOICE");
      return;
    }

    joinVoiceChannel({
      channelId: channel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    guildTextChannels.set(message.guild.id, message.channel.id);
    await reportInfo(message.channel, `Joined **${channel.name}**. TTS ready.`, "VOICE");
  } catch (err) {
    await reportError(err, message?.channel, "SET_VOICE_CHANNEL", { emit: "channel" });
  }
}

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
    await reportError(err, message?.channel, "SET_TTS", { emit: "channel" });
  }
}

module.exports = {
  getProcessAIRequest,
  setVoiceChannel,
  setTTS,
};

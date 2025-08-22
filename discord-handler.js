// discord-handler.js — v2.7
// KI-Flow + TTS + Transcripts-Mirroring + !summarize-Helper

const { joinVoiceChannel, getVoiceConnection } = require("@discordjs/voice");
const {
  setMessageReaction,
  getChannelConfig,
  setReplyAsWebhook,
  getSpeech,
} = require("./discord-helper.js");
const { getAIResponse } = require("./aiCore.js");
const { getToolRegistry } = require("./tools.js");

// Run an AI request
async function getProcessAIRequest(message, chatContext, client, state, model, apiKey) {
  if (state.isAIProcessing >= 3) {
    try { await setMessageReaction(message, "❌"); } catch {}
    return;
  }

  state.isAIProcessing++;
  try {
    await message.react("⏳");

    const channelMeta = getChannelConfig(message.channelId);
    if (!channelMeta) {
      await setMessageReaction(message, "❌");
      return;
    }

    const senderId = String(message.author?.id || "");
    const senderName = message.member?.displayName || message.author?.username || "";
    const blocks = Array.isArray(channelMeta.blocks) ? channelMeta.blocks : [];

    const matchingBlock = blocks.find(b => {
      const okUser = Array.isArray(b.user) && b.user.map(String).includes(senderId);
      const okSpeaker = Array.isArray(b.speaker) && b.speaker.includes(senderName);
      return okUser || okSpeaker;
    });

    if (!matchingBlock) {
      await setMessageReaction(message, "❌");
      return;
    }

    const effectiveModel = matchingBlock.model || model;
    const effectiveApiKey = matchingBlock.apikey || apiKey;

    if (Array.isArray(matchingBlock.tools) && matchingBlock.tools.length > 0) {
      const { tools: blockTools, registry: blockRegistry } = getToolRegistry(matchingBlock.tools);
      chatContext.tools = blockTools;
      chatContext.toolRegistry = blockRegistry;
    } else {
      chatContext.tools = channelMeta.tools;
      chatContext.toolRegistry = channelMeta.toolRegistry;
    }

    const output = await getAIResponse(chatContext, null, null, effectiveModel, effectiveApiKey);

    if (output && output.trim()) {
      // 1) Im Textkanal als Webhook antworten
      await setReplyAsWebhook(message, output, {
        botname: channelMeta.botname,
        avatarUrl: channelMeta.avatarUrl
      });

      // 3) In den Kontext loggen als Bot
      await chatContext.add("assistant", channelMeta?.botname || "AI", output);

      await setMessageReaction(message, "✅");
    } else {
      await setMessageReaction(message, "❌");
    }
  } catch (err) {
    console.error("[AI ERROR]:", err);
    try { await setMessageReaction(message, "❌"); } catch {}
  } finally {
    state.isAIProcessing--;
  }
}

// Enter a voice channel and start listening
async function setVoiceChannel(message, guildTextChannels, _activeRecordings, _chatContext, _client) {
  const channel = message.member?.voice?.channel;
  if (!channel) {
    await message.channel.send("❌ Join a voice channel first, then run `!joinvc`.");
    return;
  }
  joinVoiceChannel({
    channelId: channel.id,
    guildId: message.guild.id,
    adapterCreator: message.guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  // Merke den zugehörigen Textkanal (für TTS & Transcripts)
  guildTextChannels.set(message.guild.id, message.channel.id);
  await message.channel.send(`🔊 Joined **${channel.name}**. TTS ready.`);
}

// Handle speech output in voice chat (TTS)
// (Wird im bot.js bei jedem messageCreate event aufgerufen)
async function setTTS(message, client, guildTextChannels) {
  if (!message.guild) return;

  // Nicht im Transcripts-Thread vorlesen
  const inThread = typeof message.channel.isThread === "function" ? message.channel.isThread() : false;
  if (inThread && message.channel.name === "Transcripts") return;

  // Summaries NIEMALS vorlesen
  const txt = (message.content || "").trim();
  const looksLikeSummary =
    txt.startsWith("**Summary") ||
    txt.includes("Summary in progress…") ||
    txt.includes("Summary completed.");

  if (looksLikeSummary) return;

  // Nur KI-Antworten vorlesen, nicht alles
  // Prüfe, ob es eine Webhook-Nachricht unseres Bots ist
  const isWebhook = !!message.webhookId;
  const effectiveChannelId = inThread ? (message.channel.parentId || message.channel.id) : message.channel.id;
  const meta = getChannelConfig(effectiveChannelId);
  const isAIWebhook =
    isWebhook &&
    (await message.channel.fetchWebhooks().then(ws => {
      const w = ws.find(x => x.id === message.webhookId);
      return w && w.name === (meta?.botname || "AI");
    }).catch(() => false));

  if (!isAIWebhook) return; // Nur echte AI-Ausgaben vorlesen (keine Userposts usw.)

  // Muss im selben Guild-Textkanal sein, in dem der Bot gerade "hängt"
  const guildId = message.guild.id;
  const expectedChannelId = guildTextChannels.get(guildId);
  if (expectedChannelId && message.channel.id !== expectedChannelId) return;

  // Verbindung und Voice-Channel prüfen
  const { getVoiceConnection } = require("@discordjs/voice");
  const connection = getVoiceConnection(guildId);
  if (!connection) return;

  // Jetzt wirklich sprechen
  const cleaned = txt
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'Link')
    .replace(/<@!?(\d+)>/g, 'someone')
    .replace(/:[^:\s]+:/g, '');

  if (cleaned) {
    const { getSpeech } = require("./discord-helper.js");
    await getSpeech(connection, guildId, cleaned, client, meta?.voice);
  }
}

module.exports = {
  getProcessAIRequest,
  setVoiceChannel,
  setTTS,
};

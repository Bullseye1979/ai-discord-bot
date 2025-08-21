// discord-handler.js — v2.7
// Handler für Discord-Aktionen
// + KI-Antworten zusätzlich in vorhandenen Transcripts-Thread kopieren

const { joinVoiceChannel, getVoiceConnection } = require("@discordjs/voice");
const {
  getChannelConfig,
  setBotPresence,
  setAddUserMessage,
  postSummariesIndividually,
  getSpeech,
  sendToTranscriptsThread, // neu
} = require("./discord-helper.js");
const { getAIResponse } = require("./aiCore.js");
const { getToolRegistry } = require("./tools.js");

// Run AI request
async function getProcessAIRequest(message, chatContext, client, state, model, apiKey) {
  if (state.isAIProcessing >= 3) {
    try { await message.react("❌"); } catch {}
    return;
  }

  state.isAIProcessing++;
  await setBotPresence(client, "⏳", "dnd");

  try {
    await message.react("⏳");

    const channelMeta = getChannelConfig(message.channelId);
    if (!channelMeta) {
      await message.react("❌");
      return;
    }

    const senderId = String(message.author?.id || "");
    const senderName = message.member?.displayName || message.author?.username || "";
    const blocks = Array.isArray(channelMeta.blocks) ? channelMeta.blocks : [];

    const matchingBlock = blocks.find((b) => {
      const okUser = Array.isArray(b.user) && b.user.map(String).includes(senderId);
      const okSpeaker = Array.isArray(b.speaker) && b.speaker.includes(senderName);
      return okUser || okSpeaker;
    });

    if (!matchingBlock) {
      await message.react("❌");
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

    if (output?.trim()) {
      await message.channel.send({ content: output });

      // KI-Antwort zusätzlich in Transcripts-Thread kopieren (nur wenn vorhanden)
      await sendToTranscriptsThread(message.channel, output, false);

      chatContext.add("assistant", channelMeta?.botname || "AI", output);
      await message.react("✅");
    } else {
      await message.react("❌");
    }
  } catch (err) {
    console.error("[ERROR]: Failed to process request:", err);
    try { await message.react("❌"); } catch {}
  } finally {
    state.isAIProcessing--;
    if (state.isAIProcessing === 0) {
      await setBotPresence(client, "✅", "online");
    }
  }
}

// Voice join (unverändert)
async function setVoiceChannel(message, guildTextChannels, activeRecordings, chatContext, client) {
  const channel = message.member?.voice?.channel;
  if (!channel) return;
  joinVoiceChannel({
    channelId: channel.id,
    guildId: message.guild.id,
    adapterCreator: message.guild.voiceAdapterCreator,
    selfDeaf: false,
  });
  guildTextChannels.set(message.guild.id, message.channel.id);
  const { setStartListening } = require("./discord-helper.js");
  setStartListening(getVoiceConnection(message.guild.id), message.guild.id, guildTextChannels, activeRecordings, client);
}

// TTS bei AI-Antworten (unverändert)
async function setTTS(message, client, guildTextChannels) {
  if (!message.guild) return;

  const guildId = message.guild.id;
  const expectedChannelId = guildTextChannels.get(guildId);
  if (message.channel.id !== expectedChannelId) return;

  const meta = getChannelConfig(message.channelId);
  if (!meta) return;

  const { botname, voice } = meta;

  const isDirectBot = message.author.id === client.user.id;
  let isAIWebhook = false;

  if (message.webhookId) {
    try {
      const webhooks = await message.channel.fetchWebhooks();
      const matching = webhooks.find((w) => w.id === message.webhookId);
      if (matching && matching.name === botname) {
        isAIWebhook = true;
      }
    } catch (err) {
      console.warn("[TTS] Webhook check failed:", err.message);
    }
  }

  if (!isDirectBot && !isAIWebhook) return;

  const botMember = await message.guild.members.fetch(client.user.id);
  const botVC = botMember.voice.channelId;
  if (!botVC) return;

  const connection = getVoiceConnection(guildId);
  if (!connection || connection.joinConfig.channelId !== botVC) return;

  const cleaned = message.content
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "Link")
    .replace(/<@!?(\d+)>/g, "jemand")
    .replace(/:[^:\s]+:/g, "");

  if (cleaned.trim()) {
    await getSpeech(connection, guildId, cleaned, client, voice);
  }
}

module.exports = {
  getProcessAIRequest,
  setVoiceChannel,
  setTTS,
};

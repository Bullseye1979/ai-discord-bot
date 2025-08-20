// discord-handler.js — v2.6
// Handler für Discord-Aktionen
// + !summarize mit Cutoff, Kontext-Neuaufbau, Message-Wiederherstellung

const { joinVoiceChannel, getVoiceConnection } = require("@discordjs/voice");
const {
  getChannelConfig,
  setBotPresence,
  setAddUserMessage,
  postSummariesIndividually,
  getSpeech,
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

    const matchingBlock = blocks.find(b => {
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

// Handle voice join
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

// TTS bei AI-Antworten
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
      const matching = webhooks.find(w => w.id === message.webhookId);
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
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'Link')
    .replace(/<@!?(\d+)>/g, 'jemand')
    .replace(/:[^:\s]+:/g, '');

  if (cleaned.trim()) {
    await getSpeech(connection, guildId, cleaned, client, voice);
  }
}

// --- !summarize ---
async function handleSummarize(message, chatContext) {
  const channelMeta = getChannelConfig(message.channelId);
  const customPrompt = channelMeta?.summaryPrompt || null;

  const cutoffMs = Date.now();

  try {
    const progress = await message.channel.send("⏳ **Summary in progress…** New messages won’t be considered.");

    // 1. Zusammenfassung erzeugen
    await chatContext.summarizeSince(cutoffMs, customPrompt);

    // 2. Channel leeren
    const me = message.guild.members.me;
    const perms = message.channel.permissionsFor(me);
    if (!perms?.has("ManageMessages") || !perms?.has("ReadMessageHistory")) {
      await message.channel.send("⚠️ I lack permissions to delete messages.");
    } else {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let beforeId = null;
      while (true) {
        const fetched = await message.channel.messages.fetch({ limit: 100, before: beforeId || undefined }).catch(() => null);
        if (!fetched || fetched.size === 0) break;
        for (const msg of fetched.values()) {
          if (msg.pinned) continue;
          try {
            await msg.delete();
          } catch {}
          await sleep(120);
        }
        const oldest = fetched.reduce((acc, m) => (acc && acc.createdTimestamp < m.createdTimestamp ? acc : m), null);
        if (!oldest) break;
        beforeId = oldest.id;
      }
    }

    // 3. Summaries posten
    const last5Desc = await chatContext.getLastSummaries(5);
    const summariesAsc = (last5Desc || []).slice().reverse().map((r) => `**${new Date(r.timestamp).toLocaleString()}**\n${r.summary}`);

    const afterRows = await chatContext.getMessagesAfter(cutoffMs);
    const leftover = afterRows?.length ? afterRows.map((r) => `**${r.sender}**: ${r.content}`).join("\n") : "";

    await postSummariesIndividually(message.channel, summariesAsc, leftover);

    await message.channel.send("✅ **Summary completed.**");
    if (progress?.deletable) await progress.delete();
  } catch (err) {
    console.error("[!summarize ERROR]:", err);
    await message.channel.send("❌ Fehler beim Zusammenfassen.");
  }
}

module.exports = {
  getProcessAIRequest,
  setVoiceChannel,
  setTTS,
  handleSummarize
};

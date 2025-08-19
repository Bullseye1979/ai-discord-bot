// Version 2.4
// Handler for Discord related actions
// ✨ ODER-Logik für user (ID) und speaker (Name)
// ✨ Silent-Deny: keine Antwort/kein TTS bei fehlender Permission
// ✨ Abgelehnte Prompts werden trotzdem in den Kontext geschrieben
// ✨ Rotes ❌ bei Ablehnung, ✅ bei erfolgreicher Verarbeitung
// ✨ Verwendet getChannelConfig (nicht getChannelMeta)

const { joinVoiceChannel, getVoiceConnection } = require("@discordjs/voice");
const { setEmptyChat, setBotPresence } = require('./discord-helper.js');
const { getAIResponse } = require('./aiCore.js');
const {
  setStartListening,
  getSpeech,
  setMessageReaction,
  getChannelConfig,
  setReplyAsWebhook,
  setAddUserMessage, // <— wichtig für Kontext-Schreiben auch bei Ablehnung
} = require('./discord-helper.js');
const { getContextAsChunks } = require('./helper.js');

// Run an AI request
async function getProcessAIRequest(message, chatContext, client, state, model) {
  // Flood-Guard
  if (state.isAIProcessing >= 3) return setMessageReaction(message, "❌");

  state.isAIProcessing++;
  await setBotPresence(client, "⏳", "dnd");

  let wasRejected = false;

  try {
    await message.react("⏳");

    // Channel-Config laden
    const channelConfig = getChannelConfig(message.channelId);
    if (!channelConfig) {
      // Prompt trotzdem in den Kontext aufnehmen
      await setAddUserMessage(message, chatContext);
      wasRejected = true; // keine Antwort senden
      return; // silent deny
    }

    const blocks = Array.isArray(channelConfig.blocks) ? channelConfig.blocks : [];
    if (blocks.length === 0) {
      // Prompt trotzdem in den Kontext aufnehmen
      await setAddUserMessage(message, chatContext);
      wasRejected = true; // keine Antwort senden
      return; // silent deny
    }

    // Absenderdaten
    const senderId = String(message.author?.id || "");
    const senderName = message.member?.displayName || message.author?.username || "";

    // Passenden Block via ODER-Logik suchen
    const block = blocks.find(b => {
      const okUser = Array.isArray(b.user) && b.user.map(String).includes(senderId);
      const okSpeaker = Array.isArray(b.speaker) && b.speaker.includes(senderName);
      return okUser || okSpeaker;
    });

    if (!block) {
      // Prompt trotzdem in den Kontext aufnehmen
      await setAddUserMessage(message, chatContext);
      wasRejected = true; // keine Antwort senden
      return; // silent deny
    }

    // ✅ Erlaubt: (User-Message ist i.d.R. schon im Kontext; NICHT doppelt hinzufügen)
    const output = await getAIResponse(
      chatContext,
      null,           // tokenlimit (Default aus aiCore)
      null,           // sequenceLimit
      block.model || model || "gpt-4" // Modell aus Block bevorzugen
    );

    if (output) {
      await setReplyAsWebhook(message, output, channelConfig || {});
      chatContext.add("assistant", channelConfig.botname || "AI", output);
    } else {
      // Kein Output von der AI => kurze Fehlermarkierung, aber keine Textantwort
      await setMessageReaction(message, "❌");
    }

  } catch (err) {
    // Fehler: keine Textantwort posten (still), nur kurze Fehler-Reaktion
    console.error("[ERROR]: Failed to process request:", err);
    wasRejected = true;
  } finally {
    state.isAIProcessing--;
    if (state.isAIProcessing === 0) {
      await setBotPresence(client, "✅", "online");
    }
    try {
      await message.reactions.removeAll();
      await message.react(wasRejected ? "❌" : "✅");
    } catch (err) {
      console.warn("[WARN]: Could not modify final reactions:", err);
    }
  }
}

// Chat löschen
async function setClearChat(message, contextStorage) {
  if (!message.member.permissions.has("ManageMessages")) return;
  await setEmptyChat(message.channel);
  contextStorage.delete(message.channelId);
}

// Enter a voice channel and start listening
async function setVoiceChannel(message, guildTextChannels, activeRecordings, chatContext, client) {
  const channel = message.member.voice.channel;
  if (!channel) return;
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: message.guild.id,
    adapterCreator: message.guild.voiceAdapterCreator,
    selfDeaf: false,
  });
  guildTextChannels.set(message.guild.id, message.channel.id);
  setStartListening(connection, message.guild.id, guildTextChannels, activeRecordings, client);
}

// Handle speech output in voice chat
async function setTTS(message, client, guildTextChannels) {
  if (!message.guild) return;

  const guildId = message.guild.id;
  const expectedChannelId = guildTextChannels.get(guildId);
  if (message.channel.id !== expectedChannelId) return;

  const { botname, voice } = getChannelConfig(message.channelId);

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

  // Bot muss im Voice-Channel sitzen
  const botMember = await message.guild.members.fetch(client.user.id);
  const botVC = botMember.voice.channelId;
  if (!botVC) return;

  const connection = getVoiceConnection(guildId);
  if (!connection || connection.joinConfig.channelId !== botVC) return;

  // Inhalt für TTS säubern
  const cleaned = message.content
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'Link')
    .replace(/<@!?(\d+)>/g, 'jemand')
    .replace(/:[^:\s]+:/g, '');

  if (cleaned.trim()) {
    await getSpeech(connection, guildId, cleaned, client, voice);
  }
}

module.exports = {
  setMessageReaction,
  getContextAsChunks,
  getProcessAIRequest,
  setClearChat,
  setVoiceChannel,
  setTTS
};

// Version 2.1
// Handler for Discord related actions
// ✨ Erweiterung: Zugriff wird anhand von userId oder speakerName geprüft
// ✨ getProcessAIRequest zieht model + apiKey aus Block

const { joinVoiceChannel, getVoiceConnection } = require("@discordjs/voice");
const { setEmptyChat, setBotPresence } = require('./discord-helper.js');
const { getAIResponse } = require('./aiCore.js');
const {
    setStartListening,
    getSpeech,
    setMessageReaction,
    getChannelMeta,
    setReplyAsWebhook
} = require('./discord-helper.js');
const { getContextAsChunks } = require('./helper.js');

// Zugriff prüfen: ist User oder Speaker erlaubt?
function getBlockForMessage(channelMeta, message) {
    if (!channelMeta?.blocks) return null;

    const senderId = message.author?.id;
    const senderName = message.webhookId ? message.author?.username : message.author?.username;

    return channelMeta.blocks.find(block =>
        (block.user && block.user.includes(senderId)) ||
        (block.speaker && block.speaker.includes(senderName))
    );
}

// Run an AI request
async function getProcessAIRequest(message, chatContext, client, state) {
    if (state.isAIProcessing >= 3) return setMessageReaction(message, "❌");

    const channelMeta = getChannelMeta(message.channelId);
    if (!channelMeta) return; // keine Channel-Config

    const block = getBlockForMessage(channelMeta, message);
    if (!block) {
        console.log(`❌ No permissions for ${message.author.username} (${message.author.id}) in channel ${message.channelId}`);
        return;
    }

    const { model, apikey } = block;

    state.isAIProcessing++;
    await setBotPresence(client, "⏳", "dnd");

    try {
        await message.react("⏳");
        const output = await getAIResponse(chatContext, null, null, model, apikey);
        if (output) {
            await setReplyAsWebhook(message, output, channelMeta || {});
            chatContext.add("assistant", channelMeta?.botname || "AI", output);
        } else {
            await message.reply("[ERROR]: No response from AI.");
        }
    } catch (err) {
        await message.reply("[ERROR]: Failed to process request." + err);
    } finally {
        state.isAIProcessing--;
        if (state.isAIProcessing === 0) {
            await setBotPresence(client, "✅", "online");
        }
        try {
            await message.reactions.removeAll();
            await message.react("✅");
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

    const meta = getChannelMeta(message.channelId);
    if (!meta) return; // keine Channel-Config -> keine Ausgabe

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

module.exports = {
    setMessageReaction,
    getContextAsChunks,
    getProcessAIRequest,
    setClearChat,
    setVoiceChannel,
    setTTS
};

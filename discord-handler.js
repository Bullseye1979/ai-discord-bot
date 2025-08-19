// Version 2.1
// Handler for Discord related actions
// ✨ Korrektur: user (ID) und speaker (Name) werden unabhängig geprüft (ODER-Logik)
// ✨ Robustere Block-Suche, fallback auf Default-Config wenn kein Block passt

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

// Run an AI request
async function getProcessAIRequest(message, chatContext, client, state, model, apiKey) {
    if (state.isAIProcessing >= 3) return setMessageReaction(message, "❌");

    state.isAIProcessing++;
    await setBotPresence(client, "⏳", "dnd");

    try {
        await message.react("⏳");

        const channelMeta = getChannelMeta(message.channelId);
        if (!channelMeta) {
            await message.reply("❌ No channel configuration found.");
            return;
        }

        // passenden Block anhand von User-ID ODER Speaker-Name suchen
        const senderId = String(message.author.id);
        const senderName = message.author.username;
        const block = channelMeta.blocks.find(b =>
            (b.user && b.user.includes(senderId)) ||
            (b.speaker && b.speaker.includes(senderName))
        );

        if (!block) {
            await message.reply(
                `❌ No permissions for ${senderName} (${senderId}) in channel ${message.channelId}`
            );
            return;
        }

        const output = await getAIResponse(chatContext, null, null, block.model || model, block.apikey || apiKey);
        if (output) {
            await setReplyAsWebhook(message, output, channelMeta || {});
            chatContext.add("assistant", channelMeta?.botname || "AI", output);
        } else {
            await message.reply("[ERROR]: No response from AI.");
        }
    } catch (err) {
        await message.reply("[ERROR]: Failed to process request. " + err);
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

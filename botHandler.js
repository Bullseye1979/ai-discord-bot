// botHandler.js
// Version 1.1 – angepasst für einfache Spracherkennung


// Requirements

const { joinVoiceChannel, getVoiceConnection } = require("@discordjs/voice");
const { setEmptyChat, setBotPresence, clearChat } = require('./discord-helper.js');
const { getAIResponse } = require('./aiCore.js');
// voice-related helper functions are also exported from discord-helper
const { setMessageReaction, getChannelConfig , setReplyAsWebhook, setStartListening, getSpeech } = require('./discord-helper.js');
const { getContextAsChunks } = require('./helper.js');
const Context = require('./context.js');


// Run an AI request

async function getProcessAIRequest(message, chatContext, client, state, model) {
    // const fakeContext = new Context("", "", chatContext.tools, chatContext.toolRegistry);
    // fakeContext.messages = chatContext.messages.map(msg => ({ ...msg }));

    if (state.isAIProcessing >= 3) return setMessageReaction(message, "❌");

    state.isAIProcessing++;
    await setBotPresence(client, "⏳", "dnd");

    try {
        await message.react("⏳");
        const output = await getAIResponse(chatContext, null, null, model);
        if (output) {
            const channelConfig = getChannelConfig(message.channelId);
            await setReplyAsWebhook(message, output, channelConfig);
            chatContext.add("assistant", channelConfig.botname, output);
        } else {
            await message.reply("[ERROR]: No response from AI.");
        }
    } catch (err) {
        await message.reply("[ERROR]: Failed to process request."+err);
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
    if (!message.member.permissions.has("ManageMessages")) {
        return; 
    }
    await setEmptyChat(message.channel);
    contextStorage.delete(message.channelId);
}


// Enter a voice channel and start listening

async function setVoiceChannel(message, guildTextChannels, activeRecordings, chatContext, client) {
    const channel = message.member.voice.channel;
    if (!channel) {
        return;
    }
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

    const { botname } = getChannelConfig(message.channelId);

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

    // ✅ NEU: Prüfen, ob der Bot selbst im Voice-Channel ist
    const botMember = await message.guild.members.fetch(client.user.id);
    const botVC = botMember.voice.channelId;

    if (!botVC) {
        console.warn(`[TTS] Bot ist nicht im Voice-Channel – keine Ausgabe`);
        return;
    }

    const connection = getVoiceConnection(guildId);
    if (!connection || connection.joinConfig.channelId !== botVC) {
        console.warn(`[TTS] Keine gültige Verbindung zum Voice-Channel – keine Ausgabe`);
        return;
    }

    const cleaned = message.content
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
        .replace(/https?:\/\/\S+/g, 'Link')
        .replace(/<@!?(\d+)>/g, 'jemand')
        .replace(/:[^:\s]+:/g, '');

    if (cleaned.trim()) {
        const { voice } = getChannelConfig(message.channelId);
        await getSpeech(connection, guildId, cleaned, client, voice);
    }
}



// Exports

module.exports = {
    setMessageReaction,
    getContextAsChunks,
    getProcessAIRequest,
    setClearChat,
    setVoiceChannel,
    setTTS
};

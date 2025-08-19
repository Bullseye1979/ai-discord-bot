// Version 2.3
// Handler for Discord related actions
// ✨ ODER-Logik: user (ID) ODER speaker (Name) müssen matchen
// ✨ Block-Check: Es muss mindestens 1 Block existieren
// ✨ Pro-Block-Einstellungen: model, apikey, tools werden pro Request gesetzt

const { joinVoiceChannel, getVoiceConnection } = require("@discordjs/voice");
const { setEmptyChat, setBotPresence } = require('./discord-helper.js');
const { getAIResponse } = require('./aiCore.js');
const {
    setStartListening,
    getSpeech,
    setMessageReaction,
    getChannelConfig,
    setReplyAsWebhook
} = require('./discord-helper.js');
const { getContextAsChunks } = require('./helper.js');
const { getToolRegistry } = require('./tools.js');

// Run an AI request
async function getProcessAIRequest(message, chatContext, client, state, fallbackModel, fallbackApiKey) {
    if (state.isAIProcessing >= 3) return setMessageReaction(message, "❌");

    state.isAIProcessing++;
    await setBotPresence(client, "⏳", "dnd");

    try {
        await message.react("⏳");

        const channelConfig = getChannelConfig(message.channelId);
        if (!channelConfig) {
            await message.reply("❌ No channel configuration found.");
            return;
        }

        // Block-Check: mindestens 1 Block muss existieren
        if (!Array.isArray(channelConfig.blocks) || channelConfig.blocks.length === 0) {
            await message.reply(`❌ No permission blocks defined in channel ${message.channelId}`);
            return;
        }

        // passenden Block anhand von User-ID ODER Speaker-Name suchen
        const senderId = String(message.author.id);
        const senderName = message.author.username;

        const block = channelConfig.blocks.find(b =>
            (Array.isArray(b.user) && b.user.map(String).includes(senderId)) ||
            (Array.isArray(b.speaker) && b.speaker.includes(senderName))
        );

        if (!block) {
            await message.reply(
                `❌ No permissions for ${senderName} (${senderId}) in channel ${message.channelId}`
            );
            return;
        }

        // Tools/Registry für diesen Request nach Block einschränken
        const requestedToolNames = Array.isArray(block.tools) ? block.tools : [];
        const { tools: blockTools, registry: blockRegistry } = getToolRegistry(requestedToolNames);

        // Vorherige Tools/Registry sichern und für den Call überschreiben
        const prevTools = chatContext.tools;
        const prevRegistry = chatContext.toolRegistry;
        chatContext.tools = blockTools;
        chatContext.toolRegistry = blockRegistry;

        // Anfrage an AI mit block-spezifischem model/apikey
        const useModel = block.model || fallbackModel || "gpt-4-turbo";
        const useApiKey = block.apikey || fallbackApiKey || null;

        const output = await getAIResponse(chatContext, null, null, useModel, useApiKey);

        // Tools/Registry wiederherstellen (für nachfolgende Nutzer im selben Channel)
        chatContext.tools = prevTools;
        chatContext.toolRegistry = prevRegistry;

        if (output) {
            await setReplyAsWebhook(message, output, channelConfig || {});
            chatContext.add("assistant", channelConfig?.botname || "AI", output);
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

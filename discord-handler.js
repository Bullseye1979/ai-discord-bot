// Version 2.5
// Handler für Discord-Aktionen
// + Neuer Command: !summarize
//   - erzeugt Summary (seit letzter), speichert in DB,
//   - löscht alle Nachrichten im Channel,
//   - postet die letzten 5 Summaries

const { joinVoiceChannel, getVoiceConnection } = require("@discordjs/voice");
const { setEmptyChat, setBotPresence, setMessageReaction, setAddUserMessage, getChannelConfig, setReplyAsWebhook, getSpeech } = require("./discord-helper.js");
const { getAIResponse } = require("./aiCore.js");
const { getContextAsChunks } = require("./helper.js");
const { getToolRegistry } = require("./tools.js");

// Run an AI request
async function getProcessAIRequest(message, chatContext, client, state, model, apiKey) {
    if (state.isAIProcessing >= 3) {
        try { await setMessageReaction(message, "❌"); } catch {}
        return;
    }

    state.isAIProcessing++;
    await setBotPresence(client, "⏳", "dnd");

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
            await setReplyAsWebhook(message, output, {
                botname: channelMeta.botname,
                avatarUrl: channelMeta.avatarUrl
            });
            chatContext.add("assistant", channelMeta?.botname || "AI", output);
            await setMessageReaction(message, "✅");
        } else {
            await setMessageReaction(message, "❌");
        }
    } catch (err) {
        console.error("[ERROR]: Failed to process request:", err);
        try { await setMessageReaction(message, "❌"); } catch {}
    } finally {
        state.isAIProcessing--;
        if (state.isAIProcessing === 0) {
            await setBotPresence(client, "✅", "online");
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

// Handle speech output in voice chat
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

// --- Neuer Command: !summarize ----------------------------------------------
async function handleSummarize(message, chatContext) {
    try {
        // 1) Summary erzeugen & speichern
        const created = await chatContext.generateAndStoreSummary(message.channelId);

        // 2) Channel leeren
        await setEmptyChat(message.channel);

        // 3) Letzte 5 Summaries posten
        const list = await chatContext.getLastSummaries(message.channelId, 5);
        if (!list || list.length === 0) {
            await setReplyAsWebhook(message, "Keine gespeicherten Zusammenfassungen vorhanden.", {});
            return;
        }
        // Neueste zuerst anzeigen
        const text = list
            .map(r => `**${new Date(r.timestamp).toLocaleString()}**\n${r.summary}`)
            .join(`\n\n---\n\n`);

        await setReplyAsWebhook(message, text, {});
    } catch (err) {
        console.error("[SUMMARIZE ERROR]:", err);
        await setReplyAsWebhook(message, "Fehler beim Erstellen/Veröffentlichen der Zusammenfassung.", {});
    }
}

module.exports = {
    setMessageReaction,
    getContextAsChunks,
    getProcessAIRequest,
    setClearChat,
    setVoiceChannel,
    setTTS,
    handleSummarize
};

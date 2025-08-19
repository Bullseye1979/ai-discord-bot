// Version 2.5
// Handler for Discord related actions
// ✨ Reaktionen: ⏳ während Verarbeitung, ❌ bei fehlender Permission/Blocks, ✅ bei erfolgreicher AI-Antwort
// ✨ ODER-Logik: userId ODER speakerName müssen matchen
// ✨ Kein Tokenverbrauch bei fehlender Permission (kein AI-Call)

const { joinVoiceChannel, getVoiceConnection } = require("@discordjs/voice");
const { setEmptyChat, setBotPresence, getChannelConfig, setReplyAsWebhook, setStartListening, getSpeech, setMessageReaction } = require('./discord-helper.js');
const { getAIResponse } = require('./aiCore.js');
const { getContextAsChunks } = require('./helper.js');

// Run an AI request
async function getProcessAIRequest(message, chatContext, client, state, model, apiKey) {
    if (state.isAIProcessing >= 3) return setMessageReaction(message, "❌");

    state.isAIProcessing++;
    await setBotPresence(client, "⏳", "dnd");

    let output = null;
    let denied = false;

    try {
        // Erste optische Rückmeldung
        try { await message.react("⏳"); } catch (_) {}

        const channelConfig = getChannelConfig(message.channelId);

        // Keine Config oder keine Blocks -> ablehnen (❌) und NICHTS weiter tun
        if (!channelConfig || !Array.isArray(channelConfig.blocks) || channelConfig.blocks.length === 0) {
            denied = true;
            return;
        }

        // passenden Block anhand von User-ID ODER Speaker-Name suchen (ODER-Logik)
        const senderId = String(message.author.id);
        const senderName = message.author.username;

        const block = channelConfig.blocks.find(b =>
            (Array.isArray(b.user) && b.user.map(String).includes(senderId)) ||
            (Array.isArray(b.speaker) && b.speaker.includes(senderName))
        );

        if (!block) {
            // Kein Permission-Block gefunden -> still ablehnen (❌), KEIN AI-Call
            denied = true;
            return;
        }

        // AI-Call mit block-spezifischem model/apikey
        const useModel = block.model || model;
        const useApiKey = block.apikey || apiKey;

        // Tools/Registry für diesen Request auf Block einschränken (falls dein Context das unterstützt)
        const prevTools = chatContext.tools;
        const prevRegistry = chatContext.toolRegistry;

        // Wenn du eine tools-Auswahl pro Block erzwingen willst, kannst du sie hier setzen:
        // (chatContext.tools = ...; chatContext.toolRegistry = ...;) – abhängig von deiner tools.js-API.

        output = await getAIResponse(chatContext, null, null, useModel, useApiKey);

        // Tools/Registry zurücksetzen
        chatContext.tools = prevTools;
        chatContext.toolRegistry = prevRegistry;

        if (output) {
            await setReplyAsWebhook(message, output, channelConfig || {});
            chatContext.add("assistant", channelConfig?.botname || "AI", output);
        }
    } catch (err) {
        // Bei Fehlern still bleiben (kein Reply in den Chat, um TTS zu sparen)
        console.error("[ERROR]: Failed to process request:", err);
        denied = true; // Zeige ❌ als Signal, dass es nicht geklappt hat
    } finally {
        state.isAIProcessing--;
        if (state.isAIProcessing === 0) {
            await setBotPresence(client, "✅", "online");
        }
        try {
            await message.reactions.removeAll();
            if (denied) {
                await message.react("❌");
            } else if (output) {
                await message.react("✅");
            }
            // Wenn weder denied noch output: keine Reaktion setzen (z. B. bei leerer Antwort)
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

    const meta = getChannelConfig(message.channelId);
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

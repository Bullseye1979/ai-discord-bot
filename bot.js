// Version 2.0
// Initiates the bot and manages the messages to discord and exposes the documents directory via HTTP
// ✨ NEU:
// - Reagiert NICHT, wenn es keine Channel-Config gibt (kein globaler Fallback).
// - Block-Auflösung pro Nachricht (user/speaker) via resolveChannelConfig.
// - Eigene Konversation pro Sender (sessionKey: user:<id> / speaker:<name>).
// - Model + API-Key pro Block.

const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const path = require('path');
const Context = require('./context.js');
const { getChannelMeta, resolveChannelConfig, setAddUserMessage, setBotPresence } = require('./discord-helper.js');
const fs = require("fs");
const { getImage } = require("./image"); // nutzt DALL·E
const {
    setMessageReaction,
    getProcessAIRequest,
    setClearChat,
    setVoiceChannel,
    setTTS
} = require('./discord-handler.js');

// -------- Avatare aus Channel-Config erzeugen (unverändert) --------
async function setAvatars() {
    const configDir = path.join(__dirname, "channel-config");
    const avatarDir = path.join(__dirname, "documents", "avatars");
    await fs.promises.mkdir(avatarDir, { recursive: true });

    if (!fs.existsSync(configDir)) return;

    const files = await fs.promises.readdir(configDir);
    const channelFiles = files.filter(f => f.endsWith(".json"));

    for (const file of channelFiles) {
        const channelId = path.basename(file, ".json");
        const avatarPath = path.join(avatarDir, `${channelId}.png`);

        if (fs.existsSync(avatarPath)) continue;
        try {
            const raw = await fs.promises.readFile(path.join(configDir, file), "utf8");
            const config = JSON.parse(raw);
            const persona = config.persona || "a generic AI assistant";
            const name = config.botname || "AI";
            const prompt = `Generate a discord portrait for a bot with the name ${name} and the following persona: "${persona}"`;
            const imageUrl = await getImage({
                arguments: JSON.stringify({
                    prompt,
                    user_id: channelId,
                    size: "1024x1024"
                })
            });
            const url = imageUrl.split("\n")[0].trim();
            const res = await fetch(url);
            const buffer = await res.arrayBuffer();
            await fs.promises.writeFile(avatarPath, Buffer.from(buffer));
        } catch (err) {
            console.warn(`⚠️ Could not generate avatar for ${channelId}:`, err.message);
        }
    }
}

// -------- Discord Setup --------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildPresences
    ]
});

// contextStorage: pro Channel eine Map je Sender (user:<id> / speaker:<name>)
const contextStorage = new Map();
const guildTextChannels = new Map();
const activeRecordings = new Map();
const state = { isAIProcessing: 0 };

// Utility: Speaker-Name von Webhook ermitteln
async function getSpeakerName(message) {
    if (!message.webhookId) return null;
    try {
        const webhooks = await message.channel.fetchWebhooks();
        const matching = webhooks.find(w => w.id === message.webhookId);
        if (matching) return matching.name || null;
    } catch (err) {
        // Fallback: evtl. message.author.username
        return message.author?.username || null;
    }
    return null;
}

client.on('messageCreate', async (message) => {
    // Ignoriere DMs
    if (!message.guild) return;

    // 1) Existiert eine Channel-Config? -> Wenn nein: GAR NICHT reagieren
    const channelMeta = getChannelMeta(message.channelId);
    if (!channelMeta) return;

    // 2) Sender-Typ bestimmen
    const isWebhook = !!message.webhookId;
    const userId = isWebhook ? null : message.author?.id;
    const speaker = isWebhook ? (await getSpeakerName(message)) : null;

    // 3) Passenden Block auflösen (user/speaker/defaults). Wenn null -> NICHT reagieren.
    const resolved = resolveChannelConfig(message.channelId, { userId, speaker });
    if (!resolved) return;

    // 4) Context-Storage pro Sender (damit unterschiedliche Blocks getrennt laufen)
    const sessionKey = speaker ? `speaker:${speaker}` : `user:${userId}`;
    if (!contextStorage.has(message.channelId)) {
        contextStorage.set(message.channelId, new Map());
    }
    const channelMap = contextStorage.get(message.channelId);

    if (!channelMap.has(sessionKey)) {
        const ctx = new Context(resolved.persona, resolved.instructions, resolved.tools, resolved.toolRegistry);
        channelMap.set(sessionKey, ctx);
    }
    const chatContext = channelMap.get(sessionKey);

    // 5) Erst TTS-Weiterleitung prüfen (wenn Bot im Voice-Channel etc.)
    await setTTS(message, client, guildTextChannels);

    // 6) User-Message in passenden Kontext legen
    await setAddUserMessage(message, chatContext);

    // 7) Trigger prüfen
    const trigger = (resolved.name || "bot").trim().toLowerCase();
    const content = (message.content || "").trim().toLowerCase();

    // Bot-Messages ohne Trigger ignorieren
    if (message.author.bot && !content.startsWith(trigger) && !content.startsWith(`!${trigger}`)) return;

    const isTrigger = content.startsWith(trigger) || content.startsWith(`!${trigger}`);

    // 8) Befehle
    if (message.content.startsWith('!context')) {
        const chunks = await chatContext.getContextAsChunks();
        for (const chunk of chunks) {
            await message.channel.send(`\`\`\`json\n${chunk}\n\`\`\``);
        }
        return;
    }
    if (message.content.startsWith('!joinvc')) {
        return setVoiceChannel(message, guildTextChannels, activeRecordings, chatContext, client);
    }
    if (message.content.startsWith('!clear')) {
        // löscht alle Sessions für diesen Channel
        await setClearChat(message, channelMap);
        return;
    }

    // 9) Antwort nur bei Trigger
    if (isTrigger) {
        return getProcessAIRequest(message, chatContext, client, state, resolved.model, resolved.apikey);
    }
});

// Start Discord Client
(async () => {
    await setAvatars();
    client.login(process.env.DISCORD_TOKEN);
})();

client.once('ready', () => {
    setBotPresence(client, "✅ Started", "online");
});

// HTTP für documents
const app = express();
const documentDirectory = path.join(__dirname, "documents");
app.use('/documents', express.static(documentDirectory, {
    index: false,
    extensions: false,
    setHeaders: (res) => {
        res.setHeader("Content-Disposition", "inline");
        res.setHeader("Access-Control-Allow-Origin", "*");
    }
}));
const PORT = 3000;
app.listen(PORT, () => {});

console.log("---------------------- BOT STARTED ---------------------------------");

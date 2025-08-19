// bot.js
// Version 2.2 (Unified Channel Context)
// - KEINE sessionKey-Prefixe mehr (weder "speaker:" noch "user:").
// - Eine gemeinsame Session pro Kanal: sessionKey = `channel:<channelId>`.
// - Webhook-Sprechername korrekt: per-message Username (message.author.username).
// - setAddUserMessage sorgt dafür, dass der Sendername = Username/Displayname im Kontext steht.

const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const path = require('path');
const Context = require('./context.js');
const { getChannelConfig, setAddUserMessage, setBotPresence } = require('./discord-helper.js');
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

// Ein gemeinsamer Kontext pro Kanal
const contextStorage = new Map();       // channelId -> Context
const guildTextChannels = new Map();
const activeRecordings = new Map();
const state = { isAIProcessing: 0 };

// Utility: Webhook-Sprechername (per-Message Username, NICHT der Webhook-Name)
async function getSpeakerName(message) {
    return message.webhookId ? (message.author?.username || null) : null;
}

client.on('messageCreate', async (message) => {
    // Ignoriere DMs
    if (!message.guild) return;

    // 1) Existiert eine Channel-Config? -> Wenn nein: GAR NICHT reagieren
    const channelMeta = getChannelConfig(message.channelId);
    if (!channelMeta) return;

    // 2) Sender-Typ bestimmen (nur noch für spätere Checks; der Kontext ist kanalweit)
    const isWebhook = !!message.webhookId;
    const userId = isWebhook ? null : message.author?.id;
    const speaker = isWebhook ? (await getSpeakerName(message)) : null;

    // 3) Kanalweiter Kontext (ein Topf pro Kanal)
    const sessionKey = `channel:${message.channelId}`;
    if (!contextStorage.has(message.channelId)) {
        const ctx = new Context(channelMeta.persona, channelMeta.instructions, channelMeta.tools, channelMeta.toolRegistry);
        contextStorage.set(message.channelId, ctx);
    }
    const chatContext = contextStorage.get(message.channelId);

    // 4) Erst TTS-Weiterleitung prüfen (falls Bot im Voice-Channel, liest er AI-Webhook aus)
    await setTTS(message, client, guildTextChannels);

    // 5) ALLE Nachrichten (User & Webhook) in den Kontext legen
    //    Der Sendername im Kontext ist Username/Displayname (wird in setAddUserMessage korrekt ermittelt)
    await setAddUserMessage(message, chatContext);

    // 6) Trigger prüfen
    const trigger = (channelMeta.name || "bot").trim().toLowerCase();
    const content = (message.content || "").trim().toLowerCase();

    // Bot-Messages ohne Trigger ignorieren (verhindert Selbstgespräche bei Bot/AI)
    if (message.author.bot && !content.startsWith(trigger) && !content.startsWith(`!${trigger}`)) return;

    const isTrigger = content.startsWith(trigger) || content.startsWith(`!${trigger}`);

    // 7) Befehle
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
        // löscht den gemeinsamen Kanal-Kontext
        contextStorage.delete(message.channelId);
        await message.react('✅').catch(() => {});
        return;
    }

    // 8) Antwort nur bei Trigger
    if (isTrigger) {
        return getProcessAIRequest(message, chatContext, client, state, channelMeta.model, channelMeta.apikey);
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

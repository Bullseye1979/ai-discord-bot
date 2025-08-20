// Version 2.1
// Übergibt die channelId an den Context, damit Summaries beim Init geladen werden.

const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const path = require('path');
const Context = require('./context.js');
const { getChannelConfig, setAddUserMessage, setBotPresence } = require('./discord-helper.js');
const fs = require("fs");
const { getImage } = require("./image");
const {
    setMessageReaction,
    getProcessAIRequest,
    setClearChat,
    setVoiceChannel,
    setTTS
} = require('./discord-handler.js');

// -------- Avatare aus Channel-Config erzeugen --------
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
        return message.author?.username || null;
    }
    return null;
}

client.on('messageCreate', async (message) => {
    if (!message.guild) return;

    const channelMeta = getChannelConfig(message.channelId);
    if (!channelMeta) return;

    const isWebhook = !!message.webhookId;
    const userId = isWebhook ? null : message.author?.id;
    const speaker = isWebhook ? (await getSpeakerName(message)) : null;

    // (optional) Access-Blocks prüfen… (ausgelassen, sofern bei dir in discord-handler geregelt)

    const sessionKey = speaker ? `speaker:${speaker}` : `user:${userId}`;
    if (!contextStorage.has(message.channelId)) {
        contextStorage.set(message.channelId, new Map());
    }
    const channelMap = contextStorage.get(message.channelId);

    if (!channelMap.has(sessionKey)) {
        // ✨ HIER: channelId an den Context übergeben, damit er die 5 Summaries lädt
        const ctx = new Context(
            channelMeta.persona,
            channelMeta.instructions,
            channelMeta.tools,
            channelMeta.toolRegistry,
            message.channelId // <— wichtig
        );
        channelMap.set(sessionKey, ctx);
    }
    const chatContext = channelMap.get(sessionKey);

    await setTTS(message, client, guildTextChannels);
    await setAddUserMessage(message, chatContext);

    const trigger = (channelMeta.name || "bot").trim().toLowerCase();
    const content = (message.content || "").trim().toLowerCase();

    if (message.author.bot && !content.startsWith(trigger) && !content.startsWith(`!${trigger}`)) return;

    const isTrigger = content.startsWith(trigger) || content.startsWith(`!${trigger}`);

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
        await setClearChat(message, channelMap);
        return;
    }
    if (message.content.startsWith('!summarize')) {
        // Wenn du den Befehl verwenden willst:
        await chatContext.summarize();
        await message.react('✅');
        return;
    }

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

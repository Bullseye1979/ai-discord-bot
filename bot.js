// bot.js
// Version 2.1 (Patched)
// Initiates the bot and manages the messages to discord and exposes the documents directory via HTTP
// ✨ Änderungen:
// - getSpeakerName: nutzt bei Webhooks den per-Message Autor-Namen (message.author.username)
// - Mapping speaker -> effectiveUserId (Guild-Member-Suche)
// - Session-Key auf user:<effectiveUserId>, damit Voice (Webhook) & Text im selben Kontext landen
// - Restliche Logik unverändert

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

// contextStorage: pro Channel eine Map je Sender (user:<id> / speaker:<name>)
const contextStorage = new Map();
const guildTextChannels = new Map();
const activeRecordings = new Map();
const state = { isAIProcessing: 0 };

// Utility: Sprechername von Webhook ermitteln (per-Message Autorname)
async function getSpeakerName(message) {
    // Für Webhook-Nachrichten liefert Discord in message.author den per-Message gesetzten Namen
    return message.webhookId ? (message.author?.username || null) : null;
}

client.on('messageCreate', async (message) => {
    // Ignoriere DMs
    if (!message.guild) return;

    // 1) Existiert eine Channel-Config? -> Wenn nein: GAR NICHT reagieren
    const channelMeta = getChannelConfig(message.channelId);
    if (!channelMeta) return;

    // 2) Sender-Typ bestimmen
    const isWebhook = !!message.webhookId;
    const rawUserId = isWebhook ? null : message.author?.id;
    const speaker = isWebhook ? (await getSpeakerName(message)) : null;

    // 2b) Speaker → echten Guild-User auflösen (damit Voice & Text denselben Kontext nutzen)
    let effectiveUserId = rawUserId;
    if (!effectiveUserId && speaker) {
        try {
            const members = await message.guild.members.fetch();
            const match = members.find(m =>
                m.displayName === speaker || m.user.username === speaker
            );
            if (match) effectiveUserId = match.id;
        } catch {
            // kein harter Fehler – fallback bleibt speaker-basiert
        }
    }

    // 3) Passenden Block auflösen (user/speaker/defaults). Wenn null -> NICHT reagieren.
    //    Für Block-Checks geben wir sowohl userId (effectiveUserId, falls vorhanden) als auch speaker rein.
    const resolved = getChannelConfig(message.channelId, { userId: effectiveUserId || rawUserId, speaker });
    if (!resolved) return;

    // 4) Context-Storage pro Sender
    //    → Wenn wir effectiveUserId haben, nutzen wir *immer* user:<id> (gemeinsamer Kontext).
    //    → Nur wenn keine ID auflösbar ist, fallback auf speaker:<name>.
    const sessionKey = effectiveUserId
        ? `user:${effectiveUserId}`
        : (speaker ? `speaker:${speaker}` : `user:${rawUserId}`);

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

    // 6) User-Message in passenden Kontext legen (gilt für Text *und* Webhook/Voice-Transkripte)
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

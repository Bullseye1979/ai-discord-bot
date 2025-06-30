// Version 1.0
// Initiates the bot and manages the messages to discord and exposes the documents directory via HTTP

// Requirements 

const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const express = require('express');
const path = require('path');
const Context = require('./context.js');
const { NAME, PERSONA, INSTRUCTIONS } = require('./config.js');
const { getChannelConfig, setAddUserMessage, setBotPresence } = require('./discord-helper.js');
const { tools, getToolRegistry } = require('./tools.js');
const fs = require("fs");
const { getImage } = require("./image"); // nutzt DALL·E
const {
    setMessageReaction,
    getProcessAIRequest,
    setClearChat,
    setVoiceChannel,
    setTTS
} = require('./discord-handler.js');


// Functions

// Create avatars

async function setAvatars() {
    const configDir = path.join(__dirname, "channel-config");
    const avatarDir = path.join(__dirname, "documents", "avatars");
    await fs.promises.mkdir(avatarDir, { recursive: true });

    const files = await fs.promises.readdir(configDir);
    const channelFiles = files.filter(f => f.endsWith(".json"));

    for (const file of channelFiles) {
        const channelId = path.basename(file, ".json");
        const avatarPath = path.join(avatarDir, `${channelId}.png`);

        if (fs.existsSync(avatarPath)) {
            continue;
        }
        try {
            const raw = await fs.promises.readFile(path.join(configDir, file), "utf8");
            const config = JSON.parse(raw);
            const persona = config.persona || "a generic AI assistant";
            const name = config.botname;
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

// Discord Setup

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildPresences
    ]
});

const contextStorage = new Map();
const guildTextChannels = new Map();
const activeRecordings = new Map();
const state = { isAIProcessing: 0 };

// Handle discord messages

client.on('messageCreate', async (message) => {

    if (!contextStorage.has(message.channelId)) {
        const { persona, instructions, tools, toolRegistry } = getChannelConfig(message.channelId);
        contextStorage.set(message.channelId, new Context(persona, instructions, tools, toolRegistry));
    }
    await setTTS(message, client, guildTextChannels); 
    const chatContext = contextStorage.get(message.channelId);
    await setAddUserMessage(message, chatContext);
    const { name } = getChannelConfig(message.channelId);
    const trigger = name.trim().toLowerCase();
    const content = message.content.trim().toLowerCase();
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
        return setClearChat(message, contextStorage);
    }
    if (isTrigger) {
        return getProcessAIRequest(message, chatContext, client, state);
    }
});


//  Start Discord CLient

(async () => {
    await setAvatars();
    client.login(process.env.DISCORD_TOKEN);
})();

client.once('ready', () => {
    setBotPresence(client, "✅ Started", "online");
});


// Start http server

const app = express();
const documentDirectory = path.join(__dirname, "documents");
app.use('/documents', express.static(documentDirectory, {
    index: false,
    extensions: false,
    setHeaders: (res, filePath) => {
        res.setHeader("Content-Disposition", "inline");
        res.setHeader("Access-Control-Allow-Origin", "*");
    }
}));
const PORT = 3000;
app.listen(PORT, () => {
});


// Show start message

console.log("---------------------- BOT STARTED ---------------------------------");

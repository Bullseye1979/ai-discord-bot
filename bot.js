// Version 2.2
// Startet den Bot, verwaltet Discord-Nachrichten und exponiert /documents via HTTP
// Neu:
// - Context erhält channelId beim Erzeugen
// - Command !summarize: fasst Kanal seit letzter Summary zusammen, leert den Channel und postet die letzten 5 Summaries

const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const path = require('path');
const fs = require('fs');
const Context = require('./context.js');
const { getChannelConfig, setAddUserMessage, setBotPresence } = require('./discord-helper.js');
const { getImage } = require('./image');

const {
  setMessageReaction,
  getProcessAIRequest,
  setClearChat,
  setVoiceChannel,
  setTTS,
  handleSummarize, // 👈 neu: Zusammenfassen & posten
} = require('./discord-handler.js');

// --- Avatare aus Channel-Config erzeugen ------------------------------------
async function setAvatars() {
  const configDir = path.join(__dirname, 'channel-config');
  const avatarDir = path.join(__dirname, 'documents', 'avatars');
  await fs.promises.mkdir(avatarDir, { recursive: true });

  if (!fs.existsSync(configDir)) return;

  const files = await fs.promises.readdir(configDir);
  const channelFiles = files.filter(f => f.endsWith('.json'));

  for (const file of channelFiles) {
    const channelId = path.basename(file, '.json');
    const avatarPath = path.join(avatarDir, `${channelId}.png`);
    if (fs.existsSync(avatarPath)) continue;

    try {
      const raw = await fs.promises.readFile(path.join(configDir, file), 'utf8');
      const config = JSON.parse(raw);
      const persona = config.persona || 'a generic AI assistant';
      const name = config.botname || 'AI';

      const prompt = `Generate a discord portrait for a bot with the name ${name} and the following persona: "${persona}"`;
      const imageUrl = await getImage({
        arguments: JSON.stringify({
          prompt,
          user_id: channelId,
          size: '1024x1024',
        }),
      });
      const url = imageUrl.split('\n')[0].trim();
      const res = await fetch(url);
      const buffer = await res.arrayBuffer();
      await fs.promises.writeFile(avatarPath, Buffer.from(buffer));
    } catch (err) {
      console.warn(`⚠️ Could not generate avatar for ${channelId}:`, err.message);
    }
  }
}

// --- Discord Setup -----------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences,
  ],
});

// Kontext-Speicher: pro Channel → Map je Sender (user:<id> / speaker:<name>)
const contextStorage = new Map();
const guildTextChannels = new Map();
const activeRecordings = new Map();
const state = { isAIProcessing: 0 };

// Speaker-Name aus Webhook ermitteln (für Session-Key)
async function getSpeakerName(message) {
  if (!message.webhookId) return null;
  try {
    const webhooks = await message.channel.fetchWebhooks();
    const matching = webhooks.find(w => w.id === message.webhookId);
    if (matching) return matching.name || null;
  } catch {
    return message.author?.username || null;
  }
  return null;
}

client.on('messageCreate', async message => {
  // Keine DMs
  if (!message.guild) return;

  // 1) Hat der Channel eine Config? → sonst GAR NICHT reagieren
  const channelMeta = getChannelConfig(message.channelId);
  if (!channelMeta) return;

  // 2) Sender-Typ feststellen
  const isWebhook = !!message.webhookId;
  const userId = isWebhook ? null : message.author?.id;
  const speaker = isWebhook ? await getSpeakerName(message) : null;

  // 3) Blockauflösung mit user/speaker (kein Fallback ⇒ kein Reply)
  const resolved = getChannelConfig(message.channelId, { userId, speaker });
  if (!resolved) return;

  // 4) Session/Context je Sender
  const sessionKey = speaker ? `speaker:${speaker}` : `user:${userId}`;
  if (!contextStorage.has(message.channelId)) {
    contextStorage.set(message.channelId, new Map());
  }
  const channelMap = contextStorage.get(message.channelId);

  if (!channelMap.has(sessionKey)) {
    // 👇 channelId in den Context geben (für SQL-Logging / Summaries)
    const ctx = new Context(
      resolved.persona,
      resolved.instructions,
      resolved.tools,
      resolved.toolRegistry,
      message.channelId
    );
    channelMap.set(sessionKey, ctx);
  }
  const chatContext = channelMap.get(sessionKey);

  // 5) TTS-Ausgabe (falls Bot im Voice-Channel etc.)
  await setTTS(message, client, guildTextChannels);

  // 6) User-Message in den passenden Kontext legen
  await setAddUserMessage(message, chatContext);

  // 7) Trigger prüfen
  const trigger = (resolved.name || 'bot').trim().toLowerCase();
  const content = (message.content || '').trim().toLowerCase();

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
    await setClearChat(message, channelMap); // löscht Sessions für diesen Channel
    return;
  }

  // 👇 NEU: Zusammenfassung, Channel leeren, letzte 5 posten
  if (message.content.startsWith('!summarize')) {
    return handleSummarize(message, chatContext);
  }

  // 9) Normale AI-Antwort nur bei Trigger
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
  setBotPresence(client, '✅ Started', 'online');
});

// HTTP-Server für /documents (z. B. PDFs, Avatare)
const app = express();
const documentDirectory = path.join(__dirname, 'documents');
app.use(
  '/documents',
  express.static(documentDirectory, {
    index: false,
    extensions: false,
    setHeaders: res => {
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Access-Control-Allow-Origin', '*');
    },
  })
);
const PORT = 3000;
app.listen(PORT, () => {});

console.log('---------------------- BOT STARTED ---------------------------------');

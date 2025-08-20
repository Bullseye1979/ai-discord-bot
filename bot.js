// Version 2.5
// - !summarize Workflow (in-progress -> summarize -> ALLES löschen -> 5 Summaries posten -> completed)
// - Keine Rücksicht auf neue Nachrichten währenddessen

const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const path = require('path');
const fs = require('fs');
const Context = require('./context.js');
const { getChannelConfig, setAddUserMessage, setBotPresence } = require('./discord-helper.js');
const { getImage } = require('./image');

// ---------- Discord Client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences,
  ],
});

// Kontexte: pro Channel ein Kontext (vereinfacht)
const contextStorage = new Map();

// ---------- Utils ----------
async function deleteAllMessages(channel) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let lastId = null;

  while (true) {
    const fetched = await channel.messages.fetch({ limit: 100, before: lastId || undefined });
    if (fetched.size === 0) break;

    for (const msg of fetched.values()) {
      try {
        if (!msg.pinned) await msg.delete();
      } catch {}
      await sleep(150);
    }

    const oldest = fetched.reduce((acc, m) => (acc && acc.createdTimestamp < m.createdTimestamp ? acc : m), null);
    if (!oldest) break;
    lastId = oldest.id;
  }
}

// Avatare aus Channel-Config erzeugen (unchanged)
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
        arguments: JSON.stringify({ prompt, user_id: channelId, size: '1024x1024' }),
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

// ---------- Message Handler ----------
client.on('messageCreate', async message => {
  if (!message.guild) return;

  const channelMeta = getChannelConfig(message.channelId);
  if (!channelMeta) return;

  // Kontext je Channel anlegen
  const key = `channel:${message.channelId}`;
  if (!contextStorage.has(key)) {
    const ctx = new Context(
      channelMeta.persona,
      channelMeta.instructions,
      channelMeta.tools,
      channelMeta.toolRegistry,
      message.channelId
    );
    contextStorage.set(key, ctx);
  }
  const chatContext = contextStorage.get(key);

  // ---- Commands ----
  if (message.content.startsWith('!context')) {
    const chunks = await chatContext.getContextAsChunks();
    for (const chunk of chunks) {
      await message.channel.send(`\`\`\`json\n${chunk}\n\`\`\``);
    }
    return;
  }

  if (message.content.startsWith('!summarize')) {
    try {
      // 0) Vorab-Hinweis posten (englisch)
      await message.channel.send("⏳ **Summary in progress…** New messages won’t be considered.");

      // 1) Summary erzeugen (bis jetzt). Kanal-spezifischer Prompt, falls vorhanden
      const cutoffMs = Date.now();
      const customPrompt = channelMeta?.summaryPrompt || channelMeta?.summary_prompt || null;
      await chatContext.summarizeSince(cutoffMs, customPrompt);

      // 2) **ALLE Nachrichten löschen**
      await deleteAllMessages(message.channel);

      // 3) 5 neueste Summaries aus DB holen (DESC) und als ASC posten (älteste → neueste)
      const last5Desc = await chatContext.getLastSummaries(5);
      if (last5Desc && last5Desc.length > 0) {
        const asc = [...last5Desc].reverse();
        const text = asc
          .map(r => `**${new Date(r.timestamp).toLocaleString()}**\n${r.summary}`)
          .join(`\n\n---\n\n`);
        await message.channel.send(text);
      } else {
        await message.channel.send("No summaries available yet.");
      }

      // 4) Abschluss-Hinweis
      await message.channel.send("✅ **Summary completed.**");

      try { await message.react('✅'); } catch {}
    } catch (err) {
      console.error('[SUMMARIZE FATAL]:', err);
      await message.channel.send("❌ Summary failed.");
    }
    return;
  }

  // ---- Normaler Flow: User-Message in den Kontext schreiben ----
  await setAddUserMessage(message, chatContext);

  // Nur auf Trigger reagieren (optional; falls verwendet)
  const trigger = (channelMeta.name || 'bot').trim().toLowerCase();
  const content = (message.content || '').trim().toLowerCase();
  const isTrigger = content.startsWith(trigger) || content.startsWith(`!${trigger}`);
  if (!isTrigger) return;

  // Lazy import, um großen Handler nicht on-top zu ziehen
  const { getProcessAIRequest } = require('./discord-handler.js');
  const state = { isAIProcessing: 0 };
  return getProcessAIRequest(message, chatContext, client, state, channelMeta.model, channelMeta.apikey);
});

// ---------- Start ----------
(async () => {
  await setAvatars();
  client.login(process.env.DISCORD_TOKEN);
})();

client.once('ready', () => {
  setBotPresence(client, '✅ Started', 'online');
});

// ---------- HTTP /documents ----------
const app = express();
const documentDirectory = path.join(__dirname, 'documents');
app.use('/documents', express.static(documentDirectory, {
  index: false,
  extensions: false,
  setHeaders: res => {
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
}));
const PORT = 3000;
app.listen(PORT, () => {});

console.log('---------------------- BOT STARTED ---------------------------------');

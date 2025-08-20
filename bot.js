// bot.js — v2.9
// Discord-Client + !summarize mit Cutoff, Chunked Posting und individuellem Prompt

const { Client, GatewayIntentBits, PermissionsBitField } = require("discord.js");
const express = require("express");
const path = require("path");
const Context = require("./context.js");
const {
  getChannelConfig,
  setAddUserMessage,
  setBotPresence,
  postSummariesIndividually,
} = require("./discord-helper.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences,
  ],
});

const contextStorage = new Map();

async function deleteAllMessages(channel) {
  const me = channel.guild.members.me;
  const perms = channel.permissionsFor(me);
  if (!perms?.has(PermissionsBitField.Flags.ManageMessages) || !perms?.has(PermissionsBitField.Flags.ReadMessageHistory)) {
    throw new Error("Missing permissions: ManageMessages and/or ReadMessageHistory");
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let beforeId = null;

  while (true) {
    const fetched = await channel.messages.fetch({ limit: 100, before: beforeId || undefined }).catch(() => null);
    if (!fetched || fetched.size === 0) break;

    for (const msg of fetched.values()) {
      if (msg.pinned) continue;
      try {
        await msg.delete();
      } catch {}
      await sleep(120);
    }

    const oldest = fetched.reduce((acc, m) => (acc && acc.createdTimestamp < m.createdTimestamp ? acc : m), null);
    if (!oldest) break;
    beforeId = oldest.id;
  }
}

client.on("messageCreate", async (message) => {
  if (!message.guild) return;

  const channelMeta = getChannelConfig(message.channelId);
  if (!channelMeta) return;

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

  // --- Commands ---
  if (message.content.startsWith("!context")) {
    const chunks = await chatContext.getContextAsChunks();
    for (const c of chunks) {
      await message.channel.send({ content: `\`\`\`json\n${c}\n\`\`\`` });
    }
    return;
  }

  if (message.content.startsWith("!summarize")) {
    let progress = null;
    try {
      progress = await message.channel.send("⏳ **Summary in progress…** New messages won’t be considered.");
    } catch {}

    const cutoffMs = Date.now();
    const customPrompt = channelMeta?.summaryPrompt || channelMeta?.summary_prompt || null;

    try {
      // 1) Zusammenfassen (nur bis Cutoff)
      await chatContext.summarizeSince(cutoffMs, customPrompt);
    } catch (e) {
      console.error("[!summarize] summarizeSince error:", e?.message || e);
    }

    try {
      // 2) Channel leeren
      await deleteAllMessages(message.channel);
    } catch (e) {
      console.error("[!summarize] deleteAllMessages error:", e?.message || e);
      await message.channel.send("⚠️ I lack permissions to delete messages (need Manage Messages + Read Message History).");
    }

    try {
      // 3) Summaries posten
      const last5Desc = await chatContext.getLastSummaries(5);
      const summariesAsc = (last5Desc || []).slice().reverse().map(
        (r) => `**${new Date(r.timestamp).toLocaleString()}**\n${r.summary}`
      );

      // 4) Nachrichten nach Cutoff anzeigen
      const afterRows = await chatContext.getMessagesAfter(cutoffMs);
      const leftover = afterRows?.length ? afterRows.map(
        (r) => `**${r.sender}**: ${r.content}`
      ).join("\n") : "";

      await postSummariesIndividually(message.channel, summariesAsc, leftover);
    } catch (e) {
      console.error("[!summarize] posting summaries error:", e?.message || e);
    }

    try {
      await message.channel.send("✅ **Summary completed.**");
    } catch {}
    try {
      if (progress?.deletable) await progress.delete();
    } catch {}

    return;
  }

  // --- Normaler Nachrichtenfluss ---
  await setAddUserMessage(message, chatContext);

  const trigger = (channelMeta.name || "bot").trim().toLowerCase();
  const content = (message.content || "").trim().toLowerCase();
  const isTrigger = content.startsWith(trigger) || content.startsWith(`!${trigger}`);
  if (!isTrigger) return;

  const { getProcessAIRequest } = require("./discord-handler.js");
  const state = { isAIProcessing: 0 };
  return getProcessAIRequest(message, chatContext, client, state, channelMeta.model, channelMeta.apikey);
});

// Start
(async () => {
  client.login(process.env.DISCORD_TOKEN);
})();
client.once("ready", () => setBotPresence(client, "✅ Started", "online"));

// Express /documents (optional)
const expressApp = express();
const documentDirectory = path.join(__dirname, "documents");
expressApp.use(
  "/documents",
  express.static(documentDirectory, {
    index: false,
    extensions: false,
    setHeaders: (res) => {
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("Access-Control-Allow-Origin", "*");
    },
  })
);
expressApp.listen(3000, () => {});

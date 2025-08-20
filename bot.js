// bot.js — v2.9
// !summarize mit Cutoff, Chat leeren, 5 Summaries einzeln posten (gechunked), 6. Nachricht für "after cutoff" (gechunked).
// Interner Kontext nach Vorgabe: System + 5 Summaries + alle Einzel-Nachrichten >= Cutoff (ohne Sammel-Nachricht).

const { Client, GatewayIntentBits, PermissionsBitField } = require("discord.js");
const express = require("express");
const path = require("path");
const Context = require("./context.js");
const {
  getChannelConfig,
  setAddUserMessage,
  setBotPresence,
  sendChunked,
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

  // ---- Commands ----
  if (message.content.startsWith("!context")) {
    const chunks = await chatContext.getContextAsChunks();
    for (const c of chunks) await sendChunked(message.channel, `\`\`\`json\n${c}\n\`\`\``);
    return;
  }

  if (message.content.startsWith("!summarize")) {
    let progress = null;
    try {
      progress = await message.channel.send("⏳ **Summary in progress…** New messages won’t be considered.");
    } catch {}

    const cutoffMs = Date.now();
    const customPrompt = channelMeta?.summaryPrompt || channelMeta?.summary_prompt || null;

    // 1) Zusammenfassen bis Cutoff -> Kontext wird: System + 5 Summaries + alle >= Cutoff
    try {
      await chatContext.summarizeSince(cutoffMs, customPrompt);
    } catch (e) {
      console.error("[!summarize] summarizeSince error:", e?.message || e);
    }

    // 2) Alle Messages im Channel löschen
    try {
      await deleteAllMessages(message.channel);
    } catch (e) {
      console.error("[!summarize] deleteAllMessages error:", e?.message || e);
      await message.channel.send("⚠️ I lack permissions to delete messages (need Manage Messages + Read Message History).");
    }

    // 3) 5 Summaries (älteste -> neueste) als einzelne Nachrichten posten (gechunked)
    let summariesAsc = [];
    try {
      const last5Desc = await chatContext.getLastSummaries(5);
      summariesAsc = (last5Desc || []).slice().reverse().map((r) => `**${new Date(r.timestamp).toLocaleString()}**\n${r.summary}`);
      if (summariesAsc.length === 0) {
        await message.channel.send("No summaries available yet.");
      } else {
        // 4) Sammeltext (nur Anzeige) für "after cutoff"
        const afterRows = await chatContext.getMessagesAfter(cutoffMs);
        const leftover = afterRows?.length ? afterRows.map((r) => `**${r.sender}**: ${r.content}`).join("\n") : "";

        await postSummariesIndividually(message.channel, summariesAsc, leftover);
      }
    } catch (e) {
      console.error("[!summarize] posting summaries error:", e?.message || e);
    }

    // 5) Abschluss
    try {
      await message.channel.send("✅ **Summary completed.**");
    } catch {}
    try {
      if (progress?.deletable) await progress.delete();
    } catch {}

    return;
  }

  // ---- Normaler Flow ----
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

// HTTP /documents (optional)
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

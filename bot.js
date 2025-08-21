// bot.js — v3.2
// !summarize: erstellt Summary, leert Chat, postet 5 Summaries (älteste → neueste).
// Bot-Nachrichten werden geloggt — ABER Antworten auf !context werden gezielt NICHT geloggt (Ignore-IDs + Zeitfenster).

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

// IDs der !context-Antwort-Messages, die wir NICHT loggen wollen
const contextDumpIgnoreIds = new Set();
// Fallback: Zeitfenster pro Channel, falls Events früher ankommen als IDs registriert werden
const contextDumpRecentTs = new Map(); // channelId -> timestamp(ms)

async function deleteAllMessages(channel) {
  const me = channel.guild.members.me;
  const perms = channel.permissionsFor(me);
  if (
    !perms?.has(PermissionsBitField.Flags.ManageMessages) ||
    !perms?.has(PermissionsBitField.Flags.ReadMessageHistory)
  ) {
    throw new Error("Missing permissions: ManageMessages and/or ReadMessageHistory");
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let beforeId = null;
  while (true) {
    const fetched = await channel.messages
      .fetch({ limit: 100, before: beforeId || undefined })
      .catch(() => null);
    if (!fetched || fetched.size === 0) break;
    for (const msg of fetched.values()) {
      if (msg.pinned) continue;
      try {
        await msg.delete();
      } catch {}
      await sleep(120);
    }
    const oldest = fetched.reduce(
      (acc, m) => (acc && acc.createdTimestamp < m.createdTimestamp ? acc : m),
      null
    );
    if (!oldest) break;
    beforeId = oldest.id;
  }
}

client.on("messageCreate", async (message) => {
  if (!message.guild) return;

  // ❗️Nur Antworten auf !context NICHT loggen:
  // a) Explizit per ID ignorieren
  if (contextDumpIgnoreIds.has(message.id)) {
    contextDumpIgnoreIds.delete(message.id);
    return;
  }
  // b) Fallback: innerhalb kurzer Zeit und mit JSON-Codeblock
  const recent = contextDumpRecentTs.get(message.channelId);
  if (
    recent &&
    Date.now() - recent < 8000 &&
    message.author?.bot &&
    typeof message.content === "string" &&
    message.content.trim().startsWith("```json")
  ) {
    return;
  }

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

  // ---- COMMAND: !context ----
  if (message.content.startsWith("!context")) {
    const chunks = await chatContext.getContextAsChunks();
    // Sende die Dumps und sammle deren IDs zum Ignorieren
    for (const c of chunks) {
      const sentMsgs = await sendChunked(message.channel, `\`\`\`json\n${c}\n\`\`\``);
      for (const m of sentMsgs) {
        if (m?.id) contextDumpIgnoreIds.add(m.id);
      }
    }
    // Setze ein kurzes Zeitfenster als zusätzliche Absicherung (Race-Condition-Fallback)
    contextDumpRecentTs.set(message.channelId, Date.now());
    return;
  }

  // ---- COMMAND: !summarize ----
  if (message.content.startsWith("!summarize")) {
    let progress = null;
    try {
      progress = await message.channel.send("⏳ **Summary in progress…** New messages won’t be considered.");
    } catch {}

    const cutoffMs = Date.now();
    const customPrompt = channelMeta?.summaryPrompt || channelMeta?.summary_prompt || null;

    // 1) Zusammenfassung erzeugen (bis Cutoff)
    try {
      await chatContext.summarizeSince(cutoffMs, customPrompt);
    } catch (e) {
      console.error("[!summarize] summarizeSince error:", e?.message || e);
    }

    // 2) Alle Nachrichten im Channel löschen
    try {
      await deleteAllMessages(message.channel);
    } catch (e) {
      console.error("[!summarize] deleteAllMessages error:", e?.message || e);
      await message.channel.send(
        "⚠️ I lack permissions to delete messages (need Manage Messages + Read Message History)."
      );
    }

    // 3) 5 Summaries (älteste → neueste) posten
    try {
      const last5Desc = await chatContext.getLastSummaries(5);
      const summariesAsc = (last5Desc || [])
        .slice()
        .reverse()
        .map((r) => `**${new Date(r.timestamp).toLocaleString()}**\n${r.summary}`);

      if (summariesAsc.length === 0) {
        await message.channel.send("No summaries available yet.");
      } else {
        await postSummariesIndividually(message.channel, summariesAsc);
      }
    } catch (e) {
      console.error("[!summarize] posting summaries error:", e?.message || e);
    }

    // 4) Abschluss
    try {
      await message.channel.send("✅ **Summary completed.**");
    } catch {}
    try {
      if (progress?.deletable) await progress.delete();
    } catch {}

    return;
  }

  // ---- NORMALE NACHRICHT ----
  // (Loggt auch Bot/Webhook-Nachrichten — außer Commands)
  await setAddUserMessage(message, chatContext);

  // Trigger prüfen (Name oder !name)
  const trigger = (channelMeta.name || "bot").trim().toLowerCase();
  const content = (message.content || "").trim().toLowerCase();
  const isTrigger = content.startsWith(trigger) || content.startsWith(`!${trigger}`);
  if (!isTrigger) return;

  const { getProcessAIRequest } = require("./discord-handler.js");
  const state = { isAIProcessing: 0 };
  return getProcessAIRequest(
    message,
    chatContext,
    client,
    state,
    channelMeta.model,
    channelMeta.apikey
  );
});

// Start Discord Bot
(async () => {
  client.login(process.env.DISCORD_TOKEN);
})();
client.once("ready", () => setBotPresence(client, "✅ Started", "online"));

// Static Hosting für /documents (optional)
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

// bot.js — v3.4
// !summarize: erstellt Summary (mit Bot-Post-Exclusion), sperrt Channel währenddessen,
// leert Chat, postet 5 Summaries (älteste → neueste), alles chunked.

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
const contextDumpRecentTs = new Map(); // channelId -> timestamp(ms)

// -------- Channel Lock/Unlock Helper --------
async function lockChannelForSummary(channel) {
  const snapshot = channel.permissionOverwrites.cache.map((o) => ({
    id: o.id,
    type: o.type,
    allow: o.allow.bitfield,
    deny: o.deny.bitfield,
  }));

  const everyone = channel.guild.roles.everyone;
  const me = channel.guild.members.me;

  try {
    await channel.permissionOverwrites.edit(
      everyone,
      { SendMessages: false, AddReactions: false, SendMessagesInThreads: false },
      { reason: "Lock during summary" }
    );
  } catch (e) {
    console.warn("[Lock] Failed to edit @everyone:", e.message);
  }

  try {
    await channel.permissionOverwrites.edit(
      me,
      { SendMessages: true, AddReactions: true, SendMessagesInThreads: true },
      { reason: "Allow bot during summary" }
    );
  } catch (e) {
    console.warn("[Lock] Failed to allow bot:", e.message);
  }

  // Rückgabe: Restore-Funktion
  return async () => {
    try {
      await channel.permissionOverwrites.set(
        snapshot.map((o) => ({
          id: o.id,
          type: o.type,
          allow: new PermissionsBitField(o.allow),
          deny: new PermissionsBitField(o.deny),
        })),
        { reason: "Unlock after summary" }
      );
    } catch (e) {
      console.error("[Unlock] Failed to restore overwrites:", e.message);
    }
  };
}

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

  // NICHT loggen: Antworten auf !context (IDs gemerkt) ODER zeitnaher JSON-Dump
  if (contextDumpIgnoreIds.has(message.id)) {
    contextDumpIgnoreIds.delete(message.id);
    return;
  }
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
      message.channelId,
      channelMeta.botname // <- wichtig: botDisplayName für Exclusion
    );
    contextStorage.set(key, ctx);
  }
  const chatContext = contextStorage.get(key);

  // ---- COMMAND: !context ----
  if (message.content.startsWith("!context")) {
    const chunks = await chatContext.getContextAsChunks();
    for (const c of chunks) {
      const sentMsgs = await sendChunked(message.channel, `\`\`\`json\n${c}\n\`\`\``);
      for (const m of sentMsgs) {
        if (m?.id) contextDumpIgnoreIds.add(m.id);
      }
    }
    contextDumpRecentTs.set(message.channelId, Date.now());
    return;
  }

  // ---- COMMAND: !summarize ----
  if (message.content.startsWith("!summarize")) {
    // 0) Cutoff direkt am Anfang setzen (vor jeder Bot-Nachricht)
    const cutoffMs = Date.now();

    // 1) Channel sperren
    let unlock = async () => {};
    try {
      unlock = await lockChannelForSummary(message.channel);
    } catch (e) {
      console.warn("[!summarize] Lock failed:", e.message);
    }

    // 2) Status posten (nach Lock; wird nicht in die Zusammenfassung fallen, da > cutoff)
    let progress = null;
    try {
      progress = await message.channel.send("⏳ **Summary in progress…** Channel is temporarily locked.");
    } catch {}

    // 3) Zusammenfassen bis Cutoff (mit Bot-Post-Exclusion)
    try {
      await chatContext.summarizeSince(cutoffMs, channelMeta?.summaryPrompt || channelMeta?.summary_prompt || null);
    } catch (e) {
      console.error("[!summarize] summarizeSince error:", e?.message || e);
    }

    // 4) Alle Messages im Channel löschen
    try {
      await deleteAllMessages(message.channel);
    } catch (e) {
      console.error("[!summarize] deleteAllMessages error:", e?.message || e);
      await message.channel.send("⚠️ I lack permissions to delete messages (need Manage Messages + Read Message History).");
    }

    // 5) 5 Summaries (älteste → neueste) einzeln & gechunked posten
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

    // 6) Abschluss + Unlock
    try {
      await message.channel.send("✅ **Summary completed.** Channel unlocked.");
    } catch {}
    if (progress?.deletable) {
      try { await progress.delete(); } catch {}
    }
    try {
      await unlock();
    } catch {}

    return;
  }

  // ---- NORMALE NACHRICHT ----
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

// bot.js — v3.4
// Commands: !context (nur anzeigen, nicht loggen), !summarize (Cutoff + Statusmeldung),
// !purge-db (DB wipe für Channel), !joinvc / !leavevc (Voice),
// TTS für AI-Antworten, Transcripts-Thread-Mirroring in discord-handler

const { Client, GatewayIntentBits, PermissionsBitField } = require("discord.js");
const express = require("express");
const path = require("path");
const { joinVoiceChannel, getVoiceConnection } = require("@discordjs/voice");
const Context = require("./context.js");
const {
  getChannelConfig,
  setStartListening,
  setAddUserMessage,
  setBotPresence,
  sendChunked,
  postSummariesIndividually,
} = require("./discord-helper.js");

const { getProcessAIRequest, setVoiceChannel, setTTS } = require("./discord-handler.js");

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
const guildTextChannels = new Map();       // guildId -> textChannelId (für TTS/Transcripts)
const activeRecordings = new Map();        // Platzhalter falls Recording reaktiviert wird


function parseTranscriptLine(raw) {
  // Matches: **Speaker Name:** message text
  const m = (raw || "").match(/^\s*\*\*([^*]+)\*\*:\s*(.+)$/s);
  if (!m) return null;
  return { speaker: m[1].trim(), text: m[2].trim() };
}

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
      try { await msg.delete(); } catch {}
      await sleep(120);
    }
    const oldest = fetched.reduce((acc, m) => (acc && acc.createdTimestamp < m.createdTimestamp ? acc : m), null);
    if (!oldest) break;
    beforeId = oldest.id;
  }
}

client.on("messageCreate", async (message) => {
  if (!message.guild) return;

  // -------- Parent-Channel-Logik für Threads --------
  // -------- Channel-Config (ohne Threads/Transcripts) --------
  const baseChannelId = message.channelId;
  const channelMeta = getChannelConfig(baseChannelId);
  if (!channelMeta) return;

  const key = `channel:${baseChannelId}`;




  if (!contextStorage.has(key)) {
    const ctx = new Context(
      channelMeta.persona,
      channelMeta.instructions,
      channelMeta.tools,
      channelMeta.toolRegistry,
      baseChannelId
    );
    contextStorage.set(key, ctx);
  }
  const chatContext = contextStorage.get(key);



  // ---------------- Commands (vor Logging!) ----------------

  // !context: nur anzeigen, NICHT loggen
  if ((message.content || "").startsWith("!context")) {
    const chunks = await chatContext.getContextAsChunks();
    for (const c of chunks) await sendChunked(message.channel, `\`\`\`json\n${c}\n\`\`\``);
    return;
  }

  // !purge-db: Channel-Einträge in beiden Tabellen löschen (Admin / ManageGuild)
  if ((message.content || "").startsWith("!purge-db")) {
    const member = message.member;
    const hasPerm =
      member.permissions.has(PermissionsBitField.Flags.Administrator) ||
      member.permissions.has(PermissionsBitField.Flags.ManageGuild);

    if (!hasPerm) {
      await message.channel.send("❌ You need **Manage Server** or **Administrator** to purge the database for this channel.");
      return;
    }

    try {
      const res = await chatContext.purgeChannelData();
      await message.channel.send(
        `🗑️ Purged database for this channel.\n- context_log deleted: **${res.contextDeleted}**\n- summaries deleted: **${res.summariesDeleted}**`
      );
    } catch (e) {
      console.error("[PURGE-DB] failed:", e);
      await message.channel.send("❌ Failed to purge database entries for this channel.");
    }
    return;
  }

 // !joinvc: Voice beitreten + Transcripts/TTS an DIESEN Textkanal binden
if ((message.content || "").startsWith("!joinvc")) {
  try {
    // echten Member holen (robust), dann Voice-Channel
    let gm = null;
    try { gm = await message.guild.members.fetch(message.author.id); } catch {}
    const vc = gm?.voice?.channel || message.member?.voice?.channel;
    if (!vc) { await message.reply("Join a voice channel first."); return; }

    const conn = joinVoiceChannel({
      channelId: vc.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    // Transkripte in diesen Textkanal spiegeln
    guildTextChannels.set(message.guild.id, message.channel.id);

    setStartListening(conn, message.guild.id, guildTextChannels, client);
    await message.channel.send(`🔊 Connected to **${vc.name}**. Transcripts will be posted here.`);
  } catch (e) {
    console.error("[!joinvc] failed:", e?.message || e);
    await message.channel.send("❌ Failed to join voice. Check my permissions (Connect/Speak) and try again.");
  }
  return;
}



  // !leavevc: Voice verlassen
  if ((message.content || "").startsWith("!leavevc")) {
    const conn = getVoiceConnection(message.guild.id);
    if (conn) {
      try { conn.destroy(); } catch {}
      guildTextChannels.delete(message.guild.id);
      await message.channel.send("👋 Left the voice channel.");
    } else {
      await message.channel.send("ℹ️ Not connected to a voice channel.");
    }
    return;
  }

  // !summarize: Statusmeldung (EN), Cutoff, Summary, Channel leeren, 5 Summaries, Cursor bump, Abschluss
  if ((message.content || "").startsWith("!summarize")) {
    let progress = null;
    try {
      progress = await message.channel.send("⏳ **Summary in progress…** New messages won’t be considered.");
    } catch {}

    const cutoffMs = Date.now();
    const customPrompt = channelMeta?.summaryPrompt || channelMeta?.summary_prompt || null;

    // 1) Zusammenfassen bis Cutoff
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
    try {
      const last5Desc = await chatContext.getLastSummaries(5);
      const summariesAsc =
        (last5Desc || [])
          .slice()
          .reverse()
          .map((r) => `**${new Date(r.timestamp).toLocaleString()}**\n${r.summary}`);

      if (summariesAsc.length === 0) {
        await message.channel.send("No summaries available yet.");
      } else {
        await postSummariesIndividually(message.channel, summariesAsc, null);
      }
    } catch (e) {
      console.error("[!summarize] posting summaries error:", e?.message || e);
    }

    // 4) Cursor nach **allen** neu geposteten (Summary-)Nachrichten hochsetzen
    try {
      await chatContext.bumpCursorToCurrentMax();
    } catch (e) {
      console.error("[!summarize] bumpCursorToCurrentMax error:", e?.message || e);
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


  // ---------------- Normaler Flow ----------------

// Hilfsfunktion: **Sprecher:** text
function parseTranscriptLine(raw) {
  const m = (raw || "").match(/^\s*\*\*([^*]+)\*\*:\s*(.+)$/s);
  if (!m) return null;
  return { speaker: m[1].trim(), text: m[2].trim() };
}

// 1) Erkennen, ob dies eine Transkriptzeile ist (vom Bot/Webhook gepostet, Form: **Sprecher:** Text)
const parsedTranscript =
  (message.author?.bot || message.webhookId) ? parseTranscriptLine(message.content || "") : null;

// 2) In den Kontext schreiben
if (parsedTranscript && parsedTranscript.text) {
  // Transkript als User-Message (Sprechername)
  await chatContext.add("user", parsedTranscript.speaker, parsedTranscript.text);
} else if (!message.author?.bot && !message.webhookId) {
  // echte User-Texte loggen
  await setAddUserMessage(message, chatContext);
} else {
  // sonst ignorieren (z.B. AI-Summaries, Systemposts)
}

// 3) TTS nur für AI-Antworten, aber NICHT für Summaries/Transkripte
try {
  const isTranscriptPost = !!parsedTranscript;
  const looksLikeSummary = /\*\*Summary\b|\bSummary completed\b|\bSummary in progress\b/i.test(message.content || "");
  if (!isTranscriptPost && !looksLikeSummary) {
    await setTTS(message, client, guildTextChannels);
  }
} catch (e) {
  console.warn("[TTS] call failed:", e?.message || e);
}

// 4) Trigger-Check
let contentRaw = message.content || "";
let speakerForProxy = null;

if (parsedTranscript && parsedTranscript.text) {
  contentRaw = parsedTranscript.text;
  speakerForProxy = parsedTranscript.speaker || null;
}

const triggerName = (channelMeta.name || "bot").trim().toLowerCase();
const norm = (contentRaw || "").trim().toLowerCase();

const isTrigger =
  norm.startsWith(triggerName) ||
  norm.startsWith(`!${triggerName}`) ||
   // (!!parsedTranscript && norm.includes(triggerName)); // bei Voice reicht Erwähnung irgendwo

if (!isTrigger) return;

// 5) An KI weitergeben – Proxy macht aus Transkriptpost eine "echte" User-Nachricht
const state = { isAIProcessing: 0 };
const proxyMsg = new Proxy(message, {
  get(target, prop) {
    if (prop === "content") return contentRaw;

    if (prop === "author") {
      const base = Reflect.get(target, "author");
      return {
        ...base,
        bot: false,
        username: speakerForProxy || base?.username || "user",
      };
    }

    if (prop === "member") {
      const base = Reflect.get(target, "member");
      if (!base) return base;
      return new Proxy(base, {
        get(tb, pb) {
          if (pb === "displayName") {
            return speakerForProxy || tb.displayName || tb?.user?.username || "user";
          }
          return Reflect.get(tb, pb);
        }
      });
    }

    return Reflect.get(target, prop);
  }
});

return getProcessAIRequest(proxyMsg, chatContext, client, state, channelMeta.model, channelMeta.apikey);

}); // ✅ FIX 1: Handler schließen!

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

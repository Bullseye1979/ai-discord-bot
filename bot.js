// bot.js — v3.4
// Commands: !context (nur anzeigen, nicht loggen), !summarize (Cutoff + Statusmeldung),
// !purge-db (DB wipe für Channel), !joinvc / !leavevc (Voice),
// TTS für AI-Antworten, Transcripts-Thread-Mirroring in discord-handler

const { Client, GatewayIntentBits, PermissionsBitField } = require("discord.js");
const express = require("express");
const path = require("path");
const fs = require("fs");
const { getAIResponse } = require("./aiCore.js");
const { joinVoiceChannel, getVoiceConnection } = require("@discordjs/voice");
const { hasChatConsent, setChatConsent, setVoiceConsent } = require("./consent.js");
const { initCron, reloadCronForChannel } = require("./scheduler.js");
const Context = require("./context.js");
const {
  getSpeech,
  getChannelConfig,
  setReplyAsWebhook,
  setStartListening,
  setAddUserMessage,
  setBotPresence,
  sendChunked,
  resetTTSPlayer,
  resetRecordingFlag,
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
const ttsGate = new Map(); // channelId -> boolean
const voiceBusy = new Map(); // key = channelId -> boolean



const crypto = require("crypto");

function ensureChatContextForChannel(channelId, contextStorage, channelMeta) {
  const key = `channel:${channelId}`;
  const signature = require("crypto").createHash("sha1").update(JSON.stringify({
    persona: channelMeta.persona || "",
    instructions: channelMeta.instructions || "",
    tools: (channelMeta.tools || []).map(t => t?.function?.name || t?.name || "").sort(),
    botname: channelMeta.botname || "",
    voice: channelMeta.voice || "",
    summaryPrompt: channelMeta.summaryPrompt || ""
  })).digest("hex");

  if (!contextStorage.has(key)) {
    const Context = require("./context.js");
    const ctx = new Context(
      channelMeta.persona,
      channelMeta.instructions,
      channelMeta.tools,
      channelMeta.toolRegistry,
      channelId
    );
    contextStorage.set(key, { ctx, sig: signature });
  } else {
    const entry = contextStorage.get(key);
    if (entry.sig !== signature) {
      const Context = require("./context.js");
      entry.ctx = new Context(
        channelMeta.persona,
        channelMeta.instructions,
        channelMeta.tools,
        channelMeta.toolRegistry,
        channelId
      );
      entry.sig = signature;
    }
  }
  return contextStorage.get(key).ctx;
}

function firstWordEqualsName(text, triggerName) {
  if (!triggerName) return false;
  const t = String(triggerName).trim().toLowerCase();

  // Erstes „Wort“ extrahieren, Satzzeichen am Rand ignorieren (Jenny, Jenny? "Jenny" etc.)
  const m = String(text || "")
    .trim()
    .match(/^([^\s.,:;!?'"„“‚’«»()[\]{}<>—–-]+)/u);

  const first = (m?.[1] || "").toLowerCase();
  return first === t;
}

function stripLeadingName(text, triggerName) {
  if (!triggerName) return String(text || "").trim();
  const esc = triggerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Entfernt: <Spaces> + Name + optionales Satzzeichen + Spaces
  const re = new RegExp(`^\\s*${esc}\\s*[.,:;!?'"„“‚’«»()\\[\\]{}<>—–-]*\\s*`, "i");
  return String(text || "").replace(re, "").trim();
}


async function handleVoiceTranscriptDirect(evt, client, contextStorage) {
  // evt: { guildId, channelId, userId, speaker, text, startedAtMs }
  const ch = await client.channels.fetch(evt.channelId).catch(() => null);
  if (!ch) { console.warn("[voice] channel missing", evt.channelId); return; }

  // Busy-Gate
  if (voiceBusy.get(evt.channelId)) {
    try { await ch.send("⏳ Ich antworte gerade – bitte kurz warten."); } catch {}
    return;
  }

  const channelMeta = getChannelConfig(evt.channelId);
  const chatContext = ensureChatContextForChannel(evt.channelId, contextStorage, channelMeta);

  if (typeof chatContext.setUserWindow === "function") {
    chatContext.setUserWindow(channelMeta.max_user_messages, { prunePerTwoNonUser: true });
  }

  // Tokenlimit (Speaker)
  const tokenlimit = Number(channelMeta.max_tokens_speaker ?? channelMeta.maxTokensSpeaker) || 1024;

  voiceBusy.set(evt.channelId, true);
  try {
    // 1) GPT call
    let replyText = "";
    try {
      replyText = await getAIResponse(
        chatContext,
        tokenlimit,     // <-- NEU
        1000,
        channelMeta.model || undefined,
        channelMeta.apikey || null
      );
      replyText = (replyText || "").trim();
    } catch (e) {
      console.error("[voice] getAIResponse failed:", e?.message || e);
      return;
    }
    if (!replyText) return;

    // 2) Kontext (Assistant)
    try {
      await chatContext.add("assistant", channelMeta.botname || "AI", replyText, Date.now());
    } catch {}

    // 3) Textantwort im Channel (Webhook/Avatar)
    try {
      const msgShim = { channel: ch };
      await setReplyAsWebhook(msgShim, replyText, { botname: channelMeta.botname || "AI" });
    } catch (e) {
      console.warn("[voice] setReplyAsWebhook failed, fallback send:", e?.message || e);
      try { await ch.send(replyText); } catch {}
    }

    // 4) TTS in Voice (falls verbunden) – Lock bleibt bis Ende TTS
    try {
      const { getVoiceConnection } = require("@discordjs/voice");
      const conn = getVoiceConnection(evt.guildId);
      if (conn) {
        await getSpeech(conn, evt.guildId, replyText, client, channelMeta.voice || "");
      } else {
        console.warn("[voice] no connection for guild", evt.guildId);
      }
    } catch (e) {
      console.warn("[voice] TTS failed:", e?.message || e);
    }
  } finally {
    voiceBusy.set(evt.channelId, false);
  }
}

function metaSig(m) {
  return crypto.createHash("sha1").update(JSON.stringify({
    persona: m.persona || "",
    instructions: m.instructions || "",
    tools: (m.tools || []).map(t => t?.function?.name || t?.name || "").sort(),
    botname: m.botname || "",
    voice: m.voice || "",
    summaryPrompt: m.summaryPrompt || ""
  })).digest("hex");
}

// erkennt, ob diese Nachricht von DEM AI-Webhook (botname) stammt
async function isAIWebhookMessage(message, channelMeta) {
  if (!message?.webhookId) return false;
  try {
    const hooks = await message.channel.fetchWebhooks();
    const w = hooks.find(x => x.id === message.webhookId);
    const expected = (channelMeta?.botname || "AI");
    return !!w && w.name === expected;
  } catch {
    return false;
  }
}


function isChannelAdmin(channelMeta, userId) {
  const ids = Array.isArray(channelMeta.admins) ? channelMeta.admins.map(String) : [];
  return ids.includes(String(userId));
}

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


// bot.js
 function buildProxyMessageForVoice(channel, text, userId, username) {
   return {
     channel,
     guild: channel.guild,
     content: text,
     webhookId: "voice-proxy",    // ← wichtig: als „Transkript/Webhook“ markieren
     author: { id: String(userId), bot: false, username: username || "user" },
     member: channel.guild?.members?.cache?.get(String(userId)) || null
   };
 }



client.on("messageCreate", async (message) => {

  if (!message.guild) return;



  // -------- Channel-Config laden (keine Threads / direkt Channel-ID) --------
  const baseChannelId = message.channelId;
  const channelMeta = getChannelConfig(baseChannelId);
  if (!channelMeta) return;

  // Context pro Channel cachen; bei Config-Änderung neu aufbauen
  const key = `channel:${baseChannelId}`;
  const signature = metaSig(channelMeta);

  if (!contextStorage.has(key)) {
    const ctx = new Context(
      channelMeta.persona,
      channelMeta.instructions,
      channelMeta.tools,
      channelMeta.toolRegistry,
      baseChannelId
    );
    contextStorage.set(key, { ctx, sig: signature });
  } else {
    const entry = contextStorage.get(key);
    if (entry.sig !== signature) {
      entry.ctx = new Context(
        channelMeta.persona,
        channelMeta.instructions,
        channelMeta.tools,
        channelMeta.toolRegistry,
        baseChannelId
      );
      entry.sig = signature;
    }
  }
  const chatContext = contextStorage.get(key).ctx;


// robustes Lesen (snake_case ODER camelCase, Zahl oder String)
const rawWindow =
  (channelMeta.max_user_messages ?? channelMeta.maxUserMessages ?? null);

const parsedWindow =
  (rawWindow === null || rawWindow === undefined || rawWindow === "")
    ? null
    : (Number.isFinite(Number(rawWindow)) ? Number(rawWindow) : null);

if (typeof chatContext.setUserWindow === "function") {
  chatContext.setUserWindow(parsedWindow, { prunePerTwoNonUser: true });
  console.log("[CTX] setUserWindow", {
    channel: baseChannelId,
    rawWindow,
    effective: chatContext._maxUserMessages
  });
}


  // ---- Zentrale Command-Gates ----
 // ---- Zentrale Command-Gates ----
const rawText = (message.content || "").trim();
const isCommand = rawText.startsWith("!");

// Bot selbst soll Cron-Kommandos immer ausführen dürfen:
const selfIssued = message.author?.id === client.user?.id;

if (isCommand) {
  // 1) Commands nur, wenn es für diesen Channel eine explizite Config-Datei gibt
  if (!channelMeta.hasConfig) {
    await message.channel.send("⚠️ Commands are disabled in channels without a channel-config file.");
    return;
  }
  // 2) Admin-Check: Bot selbst darf immer; alle anderen nur wenn in admins
  if (!selfIssued && !isChannelAdmin(channelMeta, message.author.id)) {
    await message.channel.send("⛔ You are not authorized to run commands in this channel.");
    return;
  }
}


await setAddUserMessage(message, chatContext);


// ab hier läuft die Funktion ganz normal weiter


// ---------------- Consent Short-Commands (+consent_…) ----------------
{
  const authorId = String(message.author?.id || "");
  const lower = rawText.toLowerCase();
  
  if (lower.startsWith("+consent_chat")) {
    await setChatConsent(authorId, baseChannelId, true);
    await message.channel.send("✅ Chat consent saved for this channel.");
    return;
  }
  if (lower.startsWith("+withdrawl_chat")) {
    await setChatConsent(authorId, baseChannelId, false);
    await message.channel.send("✅ Chat consent withdrawn for this channel.");
    return;
  }
  if (lower.startsWith("+consent_voice")) {
    await setVoiceConsent(authorId, baseChannelId, true);
    await message.channel.send("✅ Voice consent saved for this channel.");
    return;
  }
  if (lower.startsWith("+withdrawl_voice")) {
    await setVoiceConsent(authorId, baseChannelId, false);
    await message.channel.send("✅ Voice consent withdrawn for this channel.");
    return;
  }
}


  // ---------------- Commands (vor Logging!) ----------------


// !clear-channel / !purge-channel: löscht alle NICHT gepinnten Nachrichten im aktuellen Channel
if (rawText.startsWith("!clear-channel") || rawText.startsWith("!purge-channel")) {
  try {
    await deleteAllMessages(message.channel);
    // Bestätigung NACH dem Leeren posten (bleibt als einzige Nachricht stehen)
    await message.channel.send("🧹 Channel cleared.");
  } catch (e) {
    console.error("[!clear-channel] deleteAllMessages error:", e?.message || e);
    await message.channel.send("⚠️ I lack permissions to delete messages (need Manage Messages + Read Message History).");
  }
  return;
}



  // !context: nur anzeigen, NICHT loggen
  if ((message.content || "").startsWith("!context")) {
    const chunks = await chatContext.getContextAsChunks();
    for (const c of chunks) await sendChunked(message.channel, `\`\`\`json\n${c}\n\`\`\``);
    return;
  }

  // !reload-cron: Crontab dieses Channels neu laden
if ((message.content || "").startsWith("!reload-cron")) {
  try {
    const ok = await reloadCronForChannel(client, contextStorage, baseChannelId);
    await message.channel.send(ok ? "🔁 Cron reloaded for this channel." : "⚠️ No crontab defined for this channel.");
  } catch (e) {
    console.error("[!reload-cron] failed:", e?.message || e);
    await message.channel.send("❌ Failed to reload cron for this channel.");
  }
  return;
}


  // !purge-db: Channel-Einträge in beiden Tabellen löschen (Admin / ManageGuild)
  if ((message.content || "").startsWith("!purge-db")) {
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
    // User-VC holen
    let gm = null;
    try { gm = await message.guild.members.fetch(message.author.id); } catch {}
    const vc = gm?.voice?.channel || message.member?.voice?.channel;
    if (!vc) { await message.reply("Join a voice channel first."); return; }

    // Alte Voice-Verbindung (falls vorhanden) sauber schließen
    const old = getVoiceConnection(message.guild.id);
    if (old) {
      try { old.destroy(); } catch {}
    }
    // Recorder- und TTS-Player-Status zurücksetzen
    resetRecordingFlag(message.guild.id);
    resetTTSPlayer(message.guild.id);

    // Neue Verbindung herstellen
    const conn = joinVoiceChannel({
      channelId: vc.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    // Diesen Textkanal als Ziel (Transkripte & TTS) setzen
    guildTextChannels.set(message.guild.id, message.channel.id);

    // (Re)Start Listening – Transkripte posten ab jetzt in den aktuellen Textkanal
   // bot.js — im !joinvc-Handler:
setStartListening(conn, message.guild.id, guildTextChannels, client, async (evt) => {
  // evt: { guildId, channelId, userId, speaker, text, startedAtMs }
  const channelMeta = getChannelConfig(evt.channelId);
  const chatContext = ensureChatContextForChannel(evt.channelId, contextStorage, channelMeta);

    if (typeof chatContext.setUserWindow === "function") {
    chatContext.setUserWindow(channelMeta.max_user_messages, { prunePerTwoNonUser: true });
  }

  // ---- Gate: nur reagieren, wenn erstes Wort == channelMeta.name ----
  const TRIGGER = (channelMeta.name || "").trim();
  const invoked = firstWordEqualsName(evt.text, TRIGGER);

  // Optional: trotzdem ALLE Transkripte loggen (auch ohne Invocation)
  const LOG_ALL_TRANSCRIPTS = true;

  if (!invoked) {
    if (LOG_ALL_TRANSCRIPTS) {
      try { await chatContext.add("user", evt.speaker, evt.text, evt.startedAtMs); } catch {}
    }
    return; // ← keine Antwort erzeugen
  }

  // Für die KI das Triggerwort vorne entfernen (damit der Prompt sauber ist)
  const cleanedUserText = stripLeadingName(evt.text, TRIGGER);

  // Transkript (bereinigt) in den Kontext
  try {
    await chatContext.add("user", evt.speaker, cleanedUserText, evt.startedAtMs);
  } catch (e) {
    console.warn("[voice->DB] failed:", e?.message || e);
  }

  // Direktantwort (GPT -> Text in Channel via Webhook -> TTS in Voice)
  try {
    // Wir nutzen die bestehende Direct-Pipeline aus deiner letzten Version
    await handleVoiceTranscriptDirect(
      { ...evt, text: cleanedUserText }, // sicherheitshalber den bereinigten Text weiterreichen
      client,
      contextStorage
    );
  } catch (e) {
    console.error("[voice->direct] failed:", e?.message || e);
  }
});



    await message.channel.send(`🔊 Connected to **${vc.name}**. Transcripts & TTS are now bound here.`);
  } catch (e) {
    console.error("[!joinvc] failed:", e?.message || e);
    await message.channel.send("❌ Failed to join/move. Check my permissions (Connect/Speak) and try again.");
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
    if (!channelMeta.summariesEnabled) {
      await message.channel.send("⚠️ Summaries are disabled in this channel.");
      return;
    }

    let progress = null;
    try {
      progress = await message.channel.send("⏳ **Summary in progress…** New messages won’t be considered.");
    } catch {}

    const cutoffMs = Date.now();
    const customPrompt = channelMeta?.summaryPrompt || channelMeta?.summary_prompt || null;

    // 1) Zusammenfassen bis Cutoff
    try {
      const before = await chatContext.getLastSummaries(1).catch(() => []);
      await chatContext.summarizeSince(cutoffMs, customPrompt);
      const after = await chatContext.getLastSummaries(1).catch(() => []);
      const createdNew =
        (before.length === 0 && after.length > 0) ||
        (before.length > 0 && after.length > 0 && after[0].timestamp !== before[0].timestamp);

      if (!createdNew) {
        try { if (progress?.deletable) await progress.delete(); } catch {}
        await message.channel.send("ℹ️ No messages to summarize yet.");
        return;
      }

    } catch (e) {
      console.error("[!summarize] summarizeSince error:", e?.message || e);
      try { if (progress?.deletable) await progress.delete(); } catch {}
      await message.channel.send("❌ Summary failed.");
      return;
    }

    // 2) (Optional) Channel-Nachrichten löschen — derzeit bewusst übersprungen
    //    -> Wenn du hier den Channel leeren willst, baue deleteAllMessages(message.channel) ein.

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

    // 5) **Memory reduzieren**: nur System + letzte Summary im RAM behalten
    try {
      await chatContext.collapseToSystemAndLastSummary();
      await message.channel.send("🧠 RAM context collapsed to: **System + last summary**.");
    } catch (e) {
      console.error("[!summarize] collapseToSystemAndLastSummary error:", e?.message || e);
      await message.channel.send("⚠️ RAM context collapse failed (kept full memory).");
    }

    // 6) Abschluss
    try {
      await message.channel.send("✅ **Summary completed.**");
    } catch {}
    try {
      if (progress?.deletable) await progress.delete();
    } catch {}

    return;
  }



// ---------------- Normaler Flow ----------------

// 1) Erkennen, ob dies ein Transkript-Webhook ist (Webhooks ≠ AI-Webhook)

/*
const isWebhook = !!message.webhookId;
let isAIWebhook = false;
if (isWebhook) {
  try {
    const ws = await message.channel.fetchWebhooks();
    const w = ws.find(x => x.id === message.webhookId);
    isAIWebhook = !!w && w.name === (channelMeta?.botname || "AI");
  } catch {}
}
const isTranscriptPost = isWebhook && !isAIWebhook; // alles andere als unser AI-Webhook

// 2) In den Kontext schreiben
if (isTranscriptPost) {
  // (Webhooks = Voice; Logging steuert discord-helper via Voice-Consent)
  const speaker = message.author?.username || "Unknown";
  const text = (message.content || "").trim();
  if (text) await chatContext.add("user", speaker, text);
} else if (!message.author?.bot && !message.webhookId) {
  // echte User-Texte nur mit Chat-Consent loggen
  const ok = await hasChatConsent(message.author.id, baseChannelId);
  if (ok) {
    await setAddUserMessage(message, chatContext);
  } else {
    // keine Speicherung, kein Reply-Trigger
  }
} else {
  // sonst ignorieren
}

*/

// 3) TTS für Bot-ODER-AI-Webhook-Antworten – nur wenn Voice das Gate gesetzt hat
try {
  const looksLikeSummary =
    /\*\*Summary\b/i.test(message.content || "") ||
    /\bSummary (in progress|completed)/i.test(message.content || "");

  const isFromBot = message.author?.id === client.user?.id;
  const isFromAIWebhook = await isAIWebhookMessage(message, channelMeta);

  if ((isFromBot || isFromAIWebhook) && !looksLikeSummary) {
    if (ttsGate.get(message.channel.id) === true) {
      await setTTS(message, client, guildTextChannels);
      ttsGate.set(message.channel.id, false); // nach erster Antwort schließen
    }
  }
} catch (e) {
  console.warn("[TTS] call failed:", e?.message || e);
}





// 4) Trigger-Check (nur getippte User-Messages; Voice triggert via Callback in !joinvc)
if (message.author?.bot || message.webhookId) return; // keine Bots/Webhooks

const authorId = String(message.author?.id || "");
const hasConsent = await hasChatConsent(authorId, baseChannelId);
if (!hasConsent) return;

const contentRaw = (message.content || "").trim();
const norm = contentRaw.toLowerCase();

const triggerName = (channelMeta.name || "bot").trim().toLowerCase();
const isTrigger =
  norm.startsWith(triggerName) ||
  norm.startsWith(`!${triggerName}`);

if (!isTrigger) return;




// KI aufrufen (Typed Flow; kein Proxy nötig)
const state = { isAIProcessing: 0 };
return getProcessAIRequest(
  message,
  chatContext,
  client,
  state,
  channelMeta.model,
  channelMeta.apikey
);


}); // ✅ FIX 1: Handler schließen!

// Start
(async () => {
  client.login(process.env.DISCORD_TOKEN);
})();
client.once("ready", () => {
  setBotPresence(client, "✅ Started", "online");
  // Client mitgeben!
  initCron(client, contextStorage);
});

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

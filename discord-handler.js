// discord-handler.js — v2.7
// KI-Flow + TTS + Transcripts-Mirroring + !summarize-Helper

const { joinVoiceChannel, getVoiceConnection } = require("@discordjs/voice");
const {
  setMessageReaction,
  getChannelConfig,
  setReplyAsWebhook,
  getSpeech,
} = require("./discord-helper.js");
const { getAIResponse } = require("./aiCore.js");
const { getToolRegistry } = require("./tools.js");


    // ---- TTS Gate: nur sprechen, wenn Voice der Auslöser war ----
const ttsGate = new Map(); // channelId -> expiresAt (ms since epoch)
const TTS_TTL_MS = 15000;  // 15s reichen i.d.R. für alle Reply-Chunks

function markTTSAllowedForChannel(channelId, ttlMs = TTS_TTL_MS) {
  if (!channelId) return;
  const expires = Date.now() + ttlMs;
  ttsGate.set(String(channelId), expires);
  // Auto-Cleanup
  setTimeout(() => {
    const cur = ttsGate.get(String(channelId));
    if (cur && cur <= Date.now()) ttsGate.delete(String(channelId));
  }, ttlMs + 1000);
}

// Run an AI request
// Run an AI request
async function getProcessAIRequest(message, chatContext, client, state, model, apiKey) {
  if (state.isAIProcessing >= 3) {
    try { await setMessageReaction(message, "❌"); } catch {}
    return;
  }

  state.isAIProcessing++;
  let _instrBackup = chatContext.instructions;
  try {
    await setMessageReaction(message, "⏳");

    const channelMeta = getChannelConfig(message.channelId);
    if (!channelMeta) { await setMessageReaction(message, "❌"); return; }

    const blocks = Array.isArray(channelMeta.blocks) ? channelMeta.blocks : [];
    const isSpeakerMsg = !!message.webhookId;

    // Tokenlimit abhängig von Voice (Webhook) vs. Text — robust & geklemmt
    const tokenlimit = (() => {
      const raw = isSpeakerMsg
        ? (channelMeta.max_tokens_speaker ?? channelMeta.maxTokensSpeaker)
        : (channelMeta.max_tokens_chat    ?? channelMeta.maxTokensChat);
      const v = Number(raw);
      const def = isSpeakerMsg ? 1024 : 4096;
      return Number.isFinite(v) && v > 0 ? Math.max(32, Math.min(8192, Math.floor(v))) : def;
    })();

    // WICHTIG: Auto-Continue für Speaker hart abschalten
    const sequenceLimit = isSpeakerMsg ? 1 : 1000;

    // Effektive Channel-ID (Threads → Parent)
    const inThread = typeof message.channel.isThread === "function" ? message.channel.isThread() : false;
    const effectiveChannelId = inThread ? (message.channel.parentId || message.channel.id) : message.channel.id;

    // Wenn Voice/Transkript der Auslöser war → TTS nur zeitlich erlauben (separat handled)
    if (isSpeakerMsg) {
      markTTSAllowedForChannel(effectiveChannelId);
    }

    // Speaker-Name vs. User-ID für Block-Matching
    const speakerName = (message.member?.displayName || message.author?.username || "").trim().toLowerCase();
    const userId = String(message.author?.id || "").trim();

    function pickBlockForSpeaker() {
      let exact = null, wildcard = null;
      for (const b of blocks) {
        const sp = Array.isArray(b.speaker) ? b.speaker.map(s => String(s).trim().toLowerCase()) : [];
        if (!sp.length) continue;
        if (sp.includes("*") && !wildcard) wildcard = b;
        if (speakerName && sp.includes(speakerName) && !exact) exact = b;
      }
      return exact || wildcard || null;
    }
    function pickBlockForUser() {
      let exact = null, wildcard = null;
      for (const b of blocks) {
        const us = Array.isArray(b.user) ? b.user.map(x => String(x).trim()) : [];
        if (!us.length) continue;
        if (us.includes("*") && !wildcard) wildcard = b;
        if (userId && us.includes(userId) && !exact) exact = b;
      }
      return exact || wildcard || null;
    }

    const matchingBlock = isSpeakerMsg ? pickBlockForSpeaker() : pickBlockForUser();
    if (!matchingBlock) { await setMessageReaction(message, "❌"); return; }

    const effectiveModel  = matchingBlock.model  || model;
    const effectiveApiKey = matchingBlock.apikey || apiKey;

    if (Array.isArray(matchingBlock.tools) && matchingBlock.tools.length > 0) {
      const { tools: blockTools, registry: blockRegistry } = getToolRegistry(matchingBlock.tools);
      chatContext.tools = blockTools;
      chatContext.toolRegistry = blockRegistry;
    } else {
      chatContext.tools = channelMeta.tools;
      chatContext.toolRegistry = channelMeta.toolRegistry;
    }

    // Guard: Wenn (noch) keine Summary existiert, Halluzinationen deutlich verbieten
    try {
      const lastSumm = await chatContext.getLastSummaries(1).catch(() => []);
      if (!Array.isArray(lastSumm) || lastSumm.length === 0) {
        _instrBackup = chatContext.instructions;
        chatContext.instructions = (_instrBackup || "") +
          "\n\n[STRICT RULE] There is no existing conversation summary. Do not assume one. " +
          "Base your answer only on the visible messages. If asked about a past summary, say there is none yet.";
      }
    } catch {}

    // Bild-Uploads automatisch in den Prompt aufnehmen (nur bei echten User-Posts)
    const imageUrls = [];
    try {
      if (!message.webhookId && message.attachments?.size > 0) {
        for (const att of message.attachments.values()) {
          const ct = (att.contentType || att.content_type || "").toLowerCase();
          const isImageCT  = ct.startsWith("image/");
          const isImageExt = /\.(png|jpe?g|webp|gif|bmp)$/i.test(att.name || att.filename || att.url || "");
          if ((isImageCT || isImageExt) && att.url) imageUrls.push(att.url);
        }
      }
    } catch {}
    if (imageUrls.length) {
      const hasGetImageTool =
        Array.isArray(chatContext.tools) &&
        chatContext.tools.some(t => (t.function?.name || t.name) === "getImage");
      const hint =
        "\n\n[IMAGE UPLOAD]\n" +
        imageUrls.map(u => `- ${u}`).join("\n") +
        "\nAufgabe: Was ist auf diesem Bild zu sehen?" +
        (hasGetImageTool ? " Nutze dafür das Tool `getImage`." : "");
      chatContext.instructions = (chatContext.instructions || "") + hint;
    }

    // --- [ADD] Mode-spezifischen Zusatzprompt anhängen ---
try {
  const modeAppend = (isSpeakerMsg ? channelMeta.speechAppend : channelMeta.chatAppend) || "";
  if (modeAppend.trim()) {
    // NICHT dauerhaft ändern – Backup existiert bereits oben in _instrBackup
    chatContext.instructions = (chatContext.instructions || "") + "\n\n" + modeAppend.trim();
  }
} catch {}


    // KI abrufen
    const output = await getAIResponse(
      chatContext,
      tokenlimit,
      sequenceLimit,   // <<<<<< Auto-Continue bei Speaker = 1 ⇒ keine „continue“-Spirale
      effectiveModel,
      effectiveApiKey
    );

    if (output && String(output).trim()) {
      await setReplyAsWebhook(message, output, {
        botname: channelMeta.botname,
        avatarUrl: channelMeta.avatarUrl
      });
      await chatContext.add("assistant", channelMeta?.botname || "AI", output);
      await setMessageReaction(message, "✅");
    } else {
      await setMessageReaction(message, "❌");
    }
  } catch (err) {
    console.error("[AI ERROR]:", err);
    try { await setMessageReaction(message, "❌"); } catch {}
  } finally {
    // Instructions zurücksetzen
    try {
      if (typeof _instrBackup === "string") chatContext.instructions = _instrBackup;
    } catch {}
    state.isAIProcessing--;
  }
}


// Enter a voice channel and start listening
async function setVoiceChannel(message, guildTextChannels, _activeRecordings, _chatContext, _client) {
  const channel = message.member?.voice?.channel;
  if (!channel) {
    await message.channel.send("❌ Join a voice channel first, then run `!joinvc`.");
    return;
  }
  joinVoiceChannel({
    channelId: channel.id,
    guildId: message.guild.id,
    adapterCreator: message.guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  // Merke den zugehörigen Textkanal (für TTS & Transcripts)
  guildTextChannels.set(message.guild.id, message.channel.id);
  await message.channel.send(`🔊 Joined **${channel.name}**. TTS ready.`);
}

// Handle speech output in voice chat (TTS)
// (Wird im bot.js bei jedem messageCreate event aufgerufen)
async function setTTS(message, client, guildTextChannels) {
  if (!message.guild) return;

  // Nicht im Transcripts-Thread vorlesen
  const inThread = typeof message.channel.isThread === "function" ? message.channel.isThread() : false;
  if (inThread && message.channel.name === "Transcripts") return;

  // Summaries NIEMALS vorlesen
  const txt = (message.content || "").trim();
  const looksLikeSummary =
    txt.startsWith("**Summary") ||
    txt.includes("Summary in progress…") ||
    txt.includes("Summary completed.");

  if (looksLikeSummary) return;

  // Nur KI-Antworten vorlesen, nicht alles
  // Prüfe, ob es eine Webhook-Nachricht unseres Bots ist
  const isWebhook = !!message.webhookId;
  const effectiveChannelId = inThread ? (message.channel.parentId || message.channel.id) : message.channel.id;
  const meta = getChannelConfig(effectiveChannelId);
  const isAIWebhook =
    isWebhook &&
    (await message.channel.fetchWebhooks().then(ws => {
      const w = ws.find(x => x.id === message.webhookId);
      return w && w.name === (meta?.botname || "AI");
    }).catch(() => false));

  if (!isAIWebhook) return; // Nur echte AI-Ausgaben vorlesen (keine Userposts usw.)

// Nur sprechen, wenn der Kanal innerhalb der TTL freigeschaltet wurde (Voice-Auslöser)
const gate = ttsGate.get(String(effectiveChannelId));
if (!gate || gate < Date.now()) {
  return; // keine Freigabe → still bleiben
}



  // Muss im selben Guild-Textkanal sein, in dem der Bot gerade "hängt"
  const guildId = message.guild.id;
  const expectedChannelId = guildTextChannels.get(guildId);
  if (expectedChannelId && message.channel.id !== expectedChannelId) return;

  // Verbindung und Voice-Channel prüfen
  const { getVoiceConnection } = require("@discordjs/voice");
  const connection = getVoiceConnection(guildId);
  if (!connection) return;

  // Jetzt wirklich sprechen
  const cleaned = txt
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'Link')
    .replace(/<@!?(\d+)>/g, 'someone')
    .replace(/:[^:\s]+:/g, '');

  if (cleaned) {
    const { getSpeech } = require("./discord-helper.js");
    await getSpeech(connection, guildId, cleaned, client, meta?.voice);
  }
}

module.exports = {
  getProcessAIRequest,
  setVoiceChannel,
  setTTS,
};

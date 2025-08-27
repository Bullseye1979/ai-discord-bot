// aiCore.js — v1.6
// Chat-Loop mit Tool-Calls (robust) + DEBUG-Logs
require('dotenv').config();
const axios = require('axios');
const { OPENAI_API_URL } = require('./config.js');
const Context = require('./context.js');

/** Name-Sanitizing gemäß OpenAI (^ [^\s<|\\/>]+ $); löscht KEINE Messages, fasst nur name an */
function cleanOpenAIName(role, name) {
  if (!name) return undefined;
  // Für system/tool kein Name senden
  if (role === "system" || role === "tool") return undefined;

  let s = String(name)
    .trim()
    .replace(/[\s<|\\/>\u0000-\u001F]/g, "_") // Whitespace/Steuerz./<|\ />
    .replace(/[^A-Za-z0-9._-]/g, "_")          // Whitelist
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  s = s.slice(0, 64);
  if (!s) return undefined;

  const reserved = new Set(["assistant", "user", "system", "tool"]);
  if (reserved.has(s.toLowerCase())) return undefined;

  return s;
}

/** Sichere Axios-Fehlerausgabe (keine Tokens leaken) */
function logAxiosErrorSafe(prefix, err) {
  const msg = err?.message || String(err);
  console.error(prefix, msg);
  if (err?.response) {
    try {
      const safeHeaders = { ...err.response.headers };
      if (safeHeaders.authorization) safeHeaders.authorization = "Bearer ***";
      const cfg = err.response.config || {};
      const safeCfg = {
        method: cfg.method,
        url: cfg.url,
        headers: cfg.headers ? { ...cfg.headers, Authorization: "Bearer ***" } : undefined
      };
      console.error(`${prefix} Response:`, {
        status: err.response.status,
        statusText: err.response.statusText,
        headers: safeHeaders,
        data: err.response.data,
        config: safeCfg
      });
    } catch (e) {
      console.error(`${prefix} (while masking)`, e);
    }
  }
}

/**
 * Hauptloop
 * @param {Context} context_orig
 * @param {number} tokenlimit
 * @param {number} sequenceLimit
 * @param {string} model
 * @param {string|null} apiKey
 */
a// Run an AI request
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


module.exports = { getAIResponse };

// discord-helper.js — refactored v3.5 (v3.4 + _API.pseudotoolcalls flag)
// Avatar aus Channel-Config-Prompt (+ Persona/Name-Addendum), Cache-Busting, strict channel-only config, safe URLs
// NEU: getChannelConfig() normalisiert einen _API-Block → { api: { enabled, key, model?, max_tokens?, tools[], toolRegistry{}, apikey?, endpoint?, pseudotoolcalls? } }

const fs = require("fs");
const os = require("os");
const path = require("path");
const { getToolRegistry } = require("./tools.js");
const { EndBehaviorType } = require("@discordjs/voice");
const { PassThrough } = require("stream");
const { hasVoiceConsent } = require("./consent.js");
const prism = require("prism-media");
const ffmpeg = require("fluent-ffmpeg");
const axios = require("axios");
const { getAIImage, getTranscription, getTTS } = require("./aiService.js");
const { reportError } = require("./error.js");
require("dotenv").config();

ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH || "/usr/bin/ffmpeg");

// State
const activeRecordings = new Map();
const _avatarInFlight = new Map();
const queueMap = new Map();
const playerMap = new Map();

/** Base-URL für öffentliche Dateien */
function publicBase() {
  const base = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
  return base || "https://ralfreschke.de";
}

/** mtime der Avatar-Datei (ms) oder 0 */
function avatarMtimeMs(channelId) {
  try {
    const p = path.join(__dirname, "documents", "avatars", `${channelId}.png`);
    const st = fs.statSync(p);
    return Math.floor(st.mtimeMs || 0);
  } catch { return 0; }
}

/** Public-URL für Avatar; withVersion => ?v=mtime als Cache-Buster */
function buildPublicAvatarUrl(channelId, withVersion = true) {
  const v = withVersion ? avatarMtimeMs(channelId) : 0;
  const base = `${publicBase()}/documents/avatars/${channelId}.png`;
  return withVersion ? `${base}?v=${v}` : base;
}

/** Endgültigen Avatar-Prompt aufbauen:
 *  1) Primär: channelMeta.avatarPrompt / imagePrompt (wie in der Config)
 *  2) Zusatzinfos: Botname, Persona (kurz), und harte Discord-Avatar-Constraints
 *  3) Fallback: sehr kurzer generischer Prompt
 */
async function buildAvatarPrompt(channelMeta = {}) {
  try {
    const botname = String(channelMeta?.botname || channelMeta?.name || "bot").trim();
    const persona = String(channelMeta?.persona || "").trim();

    const baseFromConfig =
      (typeof channelMeta?.avatarPrompt === "string" && channelMeta.avatarPrompt.trim()) ||
      (typeof channelMeta?.imagePrompt === "string" && channelMeta.imagePrompt.trim()) ||
      "";

    const constraints =
      "\ncentered, portrait, discord avatar, no text, no logo, no watermark" ;

    if (baseFromConfig) {
      const personaLine = persona ? `\n (inspired by persona: ${persona})` : "";
      return `${baseFromConfig} — for ${botname}; ${constraints}${personaLine ? "; " + personaLine : ""}`;
    }

    // Minimaler Fallback, falls keine Vorgabe in der Config steht
    const personaHint = persona ? `, subtle hints from persona: ${persona.slice(0, 120)}` : "";
    return `Minimal, friendly ${botname} mascot head-and-shoulders; clean vector lines${personaHint}; ${constraints}`;
  } catch (err) {
    await reportError(err, null, "BUILD_AVATAR_PROMPT");
    return "Minimal, friendly bot mascot; clean vector lines; " +
           "Discord BOT avatar / icon; square, centered, high contrast, neutral background; no text, no logos";
  }
}

/** Avatar sicherstellen (einmalig generieren) und versionierte URL zurückgeben */
async function ensureChannelAvatar(channelId, channelMeta) {
  try {
    const dir = path.join(__dirname, "documents", "avatars");
    const file = path.join(dir, `${channelId}.png`);
    const sidecar = path.join(dir, `${channelId}.prompt.txt`);
    await fs.promises.mkdir(dir, { recursive: true });

    if (fs.existsSync(file)) return buildPublicAvatarUrl(channelId, true);

    if (_avatarInFlight.has(channelId)) {
      await _avatarInFlight.get(channelId).catch(() => {});
      return buildPublicAvatarUrl(fs.existsSync(file) ? channelId : "default", true);
    }

    const p = (async () => {
      const visualPrompt = await buildAvatarPrompt(channelMeta || {});
      try { await fs.promises.writeFile(sidecar, visualPrompt, "utf8"); } catch {}
      const imageUrl = await getAIImage(visualPrompt, "1024x1024", "dall-e-3");
      const res = await axios.get(imageUrl, { responseType: "arraybuffer" });
      await fs.promises.writeFile(file, Buffer.from(res.data));
    })();

    _avatarInFlight.set(channelId, p);
    await p;
    _avatarInFlight.delete(channelId);

    return buildPublicAvatarUrl(channelId, true);
  } catch (err) {
    _avatarInFlight.delete(channelId);
    await reportError(err, null, "ENSURE_CHANNEL_AVATAR");
    return buildPublicAvatarUrl("default", true);
  }
}

/** Channel-Config ausschließlich aus channel-config/<channelId>.json (+ _API Normalisierung) */
function getChannelConfig(channelId) {
  try {
    const configPath = path.join(__dirname, "channel-config", `${channelId}.json`);
    const hasConfigFile = fs.existsSync(configPath);
    if (!hasConfigFile) {
      return {
        name: "", botname: "AI", voice: "", persona: "",
        avatarUrl: buildPublicAvatarUrl("default", true),
        instructions: "", tools: [], toolRegistry: {}, blocks: [], summaryPrompt: "",
        max_user_messages: null, hasConfig: false, summariesEnabled: false, admins: [],
        max_tokens_chat: 4096, max_tokens_speaker: 1024, chatAppend: "", speechAppend: "",
        avatarPrompt: "", imagePrompt: "",
        // Neuer API-Block: disabled default
        api: { enabled: false, key: "", model: "", max_tokens: null, tools: [], toolRegistry: {}, apikey: "", endpoint: "", pseudotoolcalls: false }
      };
    }

    const raw = fs.readFileSync(configPath, "utf8");
    const cfg = JSON.parse(raw);

    const persona = typeof cfg.persona === "string" ? cfg.persona : "";
    const instructions = typeof cfg.instructions === "string" ? cfg.instructions : "";
    const voice = typeof cfg.voice === "string" ? cfg.voice : "";
    const name = typeof cfg.name === "string" ? cfg.name : "";
    const botname = typeof cfg.botname === "string" ? cfg.botname : "AI";
    const selectedTools = Array.isArray(cfg.tools) ? cfg.tools : [];
    const blocks = Array.isArray(cfg.blocks) ? cfg.blocks : [];

    const summaryPrompt = (typeof cfg.summaryPrompt === "string" && cfg.summaryPrompt) ||
                          (typeof cfg.summary_prompt === "string" && cfg.summary_prompt) || "";

    const rawMax = (cfg.max_user_messages ?? cfg.maxUserMessages);
    const max_user_messages =
      (rawMax === null || rawMax === undefined || rawMax === "")
        ? null
        : (Number.isFinite(Number(rawMax)) && Number(rawMax) >= 0 ? Math.floor(Number(rawMax)) : null);

    const rawTokChat = (cfg.max_tokens_chat ?? cfg.maxTokensChat);
    const max_tokens_chat =
      (rawTokChat !== undefined && rawTokChat !== null && rawTokChat !== "" && Number(rawTokChat) > 0)
        ? Math.floor(Number(rawTokChat)) : 4096;

    const rawTokSpk = (cfg.max_tokens_speaker ?? cfg.maxTokensSpeaker);
    const max_tokens_speaker =
      (rawTokSpk !== undefined && rawTokSpk !== null && rawTokSpk !== "" && Number(rawTokSpk) > 0)
        ? Math.floor(Number(rawTokSpk)) : 1024;

    const admins = Array.isArray(cfg.admins) ? cfg.admins.map(String) : [];

    const cfgChatAppend = cfg.chatAppend ?? cfg.chatPrompt ?? cfg.chat_prompt ?? cfg.prompt_chat ?? "";
    const cfgSpeechAppend = cfg.speechAppend ?? cfg.speechPrompt ?? cfg.speech_prompt ?? cfg.prompt_speech ?? "";

    const chatAppend = typeof cfgChatAppend === "string" ? cfgChatAppend.trim() : "";
    const speechAppend = typeof cfgSpeechAppend === "string" ? cfgSpeechAppend.trim() : "";

    // Avatar-Prompt aus Config mitgeben (für ensureChannelAvatar → buildAvatarPrompt)
    const avatarPrompt = typeof cfg.avatarPrompt === "string" ? cfg.avatarPrompt : "";
    const imagePrompt = typeof cfg.imagePrompt === "string" ? cfg.imagePrompt : "";

    // Channel-Tools normalisieren
    const { registry: toolRegistry, tools: ctxTools } = getToolRegistry(selectedTools);

    // Avatar-URL berechnen
    const avatarPath = path.join(__dirname, "documents", "avatars", `${channelId}.png`);
    const avatarUrl = fs.existsSync(avatarPath) ? buildPublicAvatarUrl(channelId, true) : buildPublicAvatarUrl("default", true);

    const summariesEnabled = !!String(summaryPrompt || "").trim();

    // ===== NEU: _API-Block normalisieren =====
    const apiRaw = (cfg._API && typeof cfg._API === "object") ? cfg._API : null;
    let api = {
      enabled: false,
      key: "",
      model: "",
      max_tokens: null,
      tools: [],
      toolRegistry: {},
      apikey: "",
      endpoint: "",
      pseudotoolcalls: false
    };
    if (apiRaw) {
      api.enabled = !!apiRaw.enabled;
      api.key = typeof apiRaw.key === "string" ? apiRaw.key : "";
      api.model = typeof apiRaw.model === "string" ? apiRaw.model : "";
      api.max_tokens = Number.isFinite(Number(apiRaw.max_tokens)) ? Math.floor(Number(apiRaw.max_tokens)) : null;
      api.apikey = typeof apiRaw.apikey === "string" ? apiRaw.apikey : "";
      api.endpoint = typeof apiRaw.endpoint === "string" ? apiRaw.endpoint : "";
      api.pseudotoolcalls = !!apiRaw.pseudotoolcalls; // <— NEU

      // API-Tools separat aufbereiten
      const apiToolsInput = Array.isArray(apiRaw.tools) ? apiRaw.tools : [];
      const { registry: apiToolReg, tools: apiTools } = getToolRegistry(apiToolsInput);
      api.tools = apiTools;
      api.toolRegistry = apiToolReg;
    }

    return {
      name, botname, voice, persona, avatarUrl, instructions,
      tools: ctxTools, toolRegistry, blocks, summaryPrompt,
      max_user_messages, hasConfig: true, summariesEnabled, admins,
      max_tokens_chat, max_tokens_speaker, chatAppend, speechAppend,
      avatarPrompt, imagePrompt,
      // neu
      api
    };
  } catch (err) {
    reportError(err, null, "GET_CHANNEL_CONFIG");
    return {
      name: "", botname: "AI", voice: "", persona: "", avatarUrl: buildPublicAvatarUrl("default", true),
      instructions: "", tools: [], toolRegistry: {}, blocks: [], summaryPrompt: "",
      max_user_messages: null, hasConfig: false, summariesEnabled: false, admins: [],
      max_tokens_chat: 4096, max_tokens_speaker: 1024, chatAppend: "", speechAppend: "",
      avatarPrompt: "", imagePrompt: "",
      api: { enabled: false, key: "", model: "", max_tokens: null, tools: [], toolRegistry: {}, apikey: "", endpoint: "", pseudotoolcalls: false }
    };
  }
}

/** Split long text into <=2000 char chunks for Discord */
function splitIntoChunks(text, hardLimit = 2000, softLimit = 1900) {
  if (!text) return [];
  const chunks = [];
  let remaining = String(text);

  const hardSplit = (s) => s.match(new RegExp(`[\\s\\S]{1,${hardLimit}}`, "g")) || [];

  while (remaining.length > softLimit) {
    let cut = remaining.lastIndexOf("\n\n", softLimit);
    if (cut === -1) cut = remaining.lastIndexOf("\n", softLimit);
    if (cut === -1) cut = remaining.lastIndexOf(" ", softLimit);
    if (cut === -1) cut = softLimit;

    const part = remaining.slice(0, cut).trim();
    if (!part) {
      const [first] = hardSplit(remaining);
      chunks.push(first);
      remaining = remaining.slice(first.length);
    } else {
      chunks.push(part);
      remaining = remaining.slice(cut).trimStart();
    }
  }
  if (remaining.length) chunks.push(remaining);

  return chunks.flatMap(hardSplit);
}

/** Send chunked message */
async function sendChunked(channel, content) {
  try {
    const parts = splitIntoChunks(content);
    for (const p of parts) await channel.send({ content: p });
  } catch (err) {
    await reportError(err, channel, "SEND_CHUNKED");
  }
}

/** Post summaries list */
async function postSummariesIndividually(channel, summaries, headerPrefix = null) {
  try {
    for (let i = 0; i < summaries.length; i++) {
      const header =
        headerPrefix ? `${headerPrefix} ${i + 1}/${summaries.length}` : `**Summary ${i + 1}/${summaries.length}**`;
      await sendChunked(channel, `${header}\n\n${summaries[i]}`);
    }
  } catch (err) {
    await reportError(err, channel, "POST_SUMMARIES");
  }
}

/** Presence */
async function setBotPresence(
  client,
  activityText = "✅ Ready",
  status = "online",
  activityType = 4 // default: CUSTOM
) {
  try {
    if (!client?.user) return;

    let activities = [];

    if (activityType === 4) {
      // Custom Status → discord.js will trotzdem "name"
      activities.push({
        type: 4,
        name: activityText,        // ja: hier MUSS "name" stehen
        emoji: undefined           // oder { name: "⏳" }
      });
    } else {
      activities.push({
        type: activityType,
        name: activityText
      });
    }

    await client.user.setPresence({
      activities,
      status
    });
  } catch (err) {
    reportError(err, null, "SET_BOT_PRESENCE");
  }
}

/** Add user message (attachments included) to context */
async function setAddUserMessage(message, chatContext) {
  try {
    const raw = (message?.content || "").trim();
    if (raw.startsWith("!")) return;

    let content = raw;
    if (message.attachments?.size > 0) {
      const links = [...message.attachments.values()].map(a => a.url).join("\n");
      content = `${links}\n${content}`.trim();
    }

    const senderName = message.member?.displayName || message.author?.username || "user";
    await chatContext.add("user", senderName, content);
  } catch (err) {
    await reportError(err, message?.channel, "SET_ADD_USER_MESSAGE");
  }
}

/** Temp file */
async function makeTmpFile(ext = ".wav") {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dgpt-"));
  const file = path.join(dir, `${Date.now()}${ext}`);
  return { dir, file };
}

/** PCM → WAV via ffmpeg */
function writePcmToWav(pcmReadable, { rate = 48000, channels = 1 } = {}) {
  return new Promise(async (resolve, reject) => {
    try {
      const { dir, file } = await makeTmpFile(".wav");
      ffmpeg()
        .input(pcmReadable)
        .inputOptions([`-f s16le`, `-ar ${rate}`, `-ac ${channels}`])
        .audioCodec("pcm_s16le")
        .format("wav")
        .save(file)
        .on("end", () => resolve({ dir, file }))
        .on("error", reject);
    } catch (err) { reject(err); }
  });
}

/** Resolve speaker display name */
async function resolveSpeakerName(client, guildId, userId) {
  try {
    const g = await client.guilds.fetch(guildId);
    const m = await g.members.fetch(userId).catch(() => null);
    return m?.displayName || m?.user?.username || "Unknown";
  } catch { return "Unknown"; }
}

/** Status reaction */
async function setMessageReaction(message, emoji) {
  try {
    const STATUS = ["⏳", "✅", "❌"];
    const me = message.client?.user;
    if (!me) return;

    const toRemove = message.reactions?.cache?.filter(r => STATUS.includes(r.emoji?.name)) || [];
    for (const r of toRemove.values()) { try { await r.users.remove(me.id); } catch {} }

    if (emoji && STATUS.includes(emoji)) { await message.react(emoji).catch(() => {}); }
  } catch (err) {
    await reportError(err, message?.channel, "SET_MESSAGE_REACTION");
  }
}

/** Helpers for embeds */
function collectUrlsWithLabels(text) {
  const out = []; const seen = new Set();
  const pushOnce = (url, label, kind, isImageExt) => {
    const clean = cleanUrl(url); if (!clean || seen.has(clean)) return;
    seen.add(clean); out.push({ url: clean, label: label || null, kind, isImageExt: !!isImageExt });
  };
  String(text || "").replace(/!\[([^\]]*)]\((https?:\/\/[^\s)]+)\)/g, (_m, alt, url) => { pushOnce(url, (alt || "").trim(), "md_image", looksLikeImage(url)); return ""; });
  String(text || "").replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => { pushOnce(url, (label || "").trim(), "md_link", looksLikeImage(url)); return ""; });
  String(text || "").replace(/https?:\/\/[^\s)]+/g, (url) => { pushOnce(url, null, "plain", looksLikeImage(url)); return ""; });
  return out;
}
async function headContentType(url) {
  try {
    const res = await axios.head(url, { maxRedirects: 5, timeout: 7000, validateStatus: null });
    const ct = res?.headers?.["content-type"] || res?.headers?.["Content-Type"]; if (ct) return String(ct);
  } catch {}
  try {
    const res = await axios.get(url, { maxRedirects: 5, timeout: 8000, responseType: "stream", validateStatus: null });
    try { res.data?.destroy?.(); } catch {}
    const ct = res?.headers?.["content-type"] || res?.headers?.["Content-Type"]; if (ct) return String(ct);
  } catch {}
  return null;
}
function prepareTextForEmbed(text) {
  let s = String(text || "");
  s = s.replace(/!\[([^\]]*)]\((https?:\/\/[^\s)]+)\)/g, (_m, alt, url) => {
    const a = String(alt || "").trim(); return a ? `[${a}](${url})` : `<${url}>`;
  });
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return s;
}
function looksLikeImage(u) { return /\.(png|jpe?g|gif|webp|bmp|tiff?)($|\?|\#)/i.test(u); }
function cleanUrl(u) { try { return u.replace(/[),.]+$/g, ""); } catch { return u; } }

/** NEW: TTS-Text so vorbereiten, dass keine Links vorgelesen werden.
 *  - Bilder-Markdown:  ![Alt](url)  →  "Alt" (oder "Bild" wenn Alt leer)
 *  - Links-Markdown:   [Label](url) →  "Label"
 *  - nackte URLs:      http(s)://…   →  entfernt
 */
function prepareTextForTTS(text) {
  if (!text) return "";
  let s = String(text);

  // 1) Bilder: nur Alt lesen
  s = s.replace(/!\[([^\]]*)]\((https?:\/\/[^\s)]+)\)/g, (_m, alt) => {
    const a = (alt || "").trim();
    return a || "";
  });

  // 2) Links: nur Label lesen
  s = s.replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g, (_m, label) => {
    return (label || "").trim();
  });

  // 3) nackte URLs komplett entfernen
  s = s.replace(/https?:\/\/[^\s)]+/g, "");

  // 4) Überzählige Klammern/Reste und Whitespace säubern
  s = s.replace(/[ \t]+/g, " ").replace(/\s*\(\s*\)\s*/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  return s;
}

/** Reply via webhook plain text (chunked), mit Avatar-Update und Versioning */
async function setReplyAsWebhook(message, content, { botname } = {}) {
  try {
    const isThread = typeof message.channel.isThread === "function" ? message.channel.isThread() : false;
    const hookChannel = isThread ? message.channel.parent : message.channel;

    const effectiveChannelId = isThread ? (message.channel.parentId || message.channel.id) : message.channel.id;
    const meta = getChannelConfig(effectiveChannelId);
    const personaAvatarUrl = await ensureChannelAvatar(effectiveChannelId, meta);

    const hooks = await hookChannel.fetchWebhooks();
    let hook = hooks.find((w) => w.name === (botname || "AI"));
    if (!hook) {
      hook = await hookChannel.createWebhook({ name: botname || "AI", avatar: personaAvatarUrl || undefined });
    } else {
      try { await hook.edit({ avatar: personaAvatarUrl }); } catch {}
    }

    const parts = splitIntoChunks(content);
    for (const p of parts) {
      await hook.send({
        content: p,
        username: botname || "AI",
        avatarURL: personaAvatarUrl || undefined,
        allowedMentions: { parse: [] },
        threadId: isThread ? message.channel.id : undefined
      });
    }
  } catch (err) {
    await reportError(err, message?.channel, "REPLY_WEBHOOK");
    try { await sendChunked(message.channel, content); } catch {}
  }
}

/** Reply via webhook as embeds (avatar/versioning, hard-safe chunking) */
async function setReplyAsWebhookEmbed(message, aiText, options = {}) {
  const { botname, color, model } = options || {};
  try {
    if (!aiText || !String(aiText).trim()) return;

    const isThread = typeof message.channel.isThread === "function" ? message.channel.isThread() : false;
    const hookChannel = isThread ? message.channel.parent : message.channel;

    const effectiveChannelId = isThread ? (message.channel.parentId || message.channel.id) : message.channel.id;
    const meta = getChannelConfig(effectiveChannelId);
    const personaAvatarUrl = await ensureChannelAvatar(effectiveChannelId, meta);

    const hooks = await hookChannel.fetchWebhooks();
    let hook = hooks.find((w) => w.name === (botname || meta?.botname || "AI"));
    if (!hook) {
      hook = await hookChannel.createWebhook({
        name: botname || meta?.botname || "AI",
        avatar: personaAvatarUrl || undefined
      });
    } else {
      try { await hook.edit({ avatar: personaAvatarUrl }); } catch {}
    }

    // --- Links/Bilder extrahieren + Text vorbereiten ---
    const links = collectUrlsWithLabels(aiText);

    const firstImage = await (async (list) => {
      if (!Array.isArray(list) || list.length === 0) return null;
      const mdImg = list.find(l => l.kind === "md_image"); if (mdImg) return mdImg;
      const withExt = list.find(l => l.isImageExt); if (withExt) return withExt;
      for (const l of list) {
        try {
          const ct = await headContentType(l.url);
          if (ct && /^image\//i.test(ct)) return l;
        } catch {}
      }
      return null;
    })(links);

    const bodyText = prepareTextForEmbed(aiText);
    const rest = links.filter(l => !(firstImage && l.url === firstImage.url));
    const bulletsBlock = rest.length
      ? "\n\n**More links**\n" + rest.map(l => {
          const label = (l.label && l.label.trim()) ? l.label.trim() : null;
          return label ? `• ${label} — <${l.url}>` : `• <${l.url}>`;
        }).join("\n")
      : "";

    const themeColor = Number.isInteger(color) ? color : 0x5865F2;
    const fullDesc = (bodyText + bulletsBlock).trim();

    // --- Harte Limits (Discord) ---
    const HARD_DESC_MAX = 4096;     // max description chars
    const HARD_EMBED_SUM = 6000;    // max total per single embed (desc + title + footer + author + fields)
    const MAX_EMBEDS_PER_MSG = 10;  // per message

    // --- Feste Meta/Overhead berechnen, um "Gesamt 6000" einzuhalten ---
    const authorName = String(botname || meta?.botname || "AI");
    const baseName = meta?.name ? `${meta.name}` : authorName;
    const modelPart = model && String(model).trim() ? ` (${String(model).trim()})` : "";
    const footerText = `${baseName}${modelPart}`;

    // Schätze den Overhead (Discord zählt UTF-16 Code Units; hier reicht einfache Länge)
    const EST_OVERHEAD = authorName.length + footerText.length + 32; // +32 Sicherheitsmarge
    // Budget für description unter 4096 und so, dass Summe < 6000 bleibt
    let DESC_BUDGET = Math.min(HARD_DESC_MAX, Math.max(500, HARD_EMBED_SUM - EST_OVERHEAD));
    // Extra Sicherheitsmarge gegen Off-by-one/Invisible chars
    DESC_BUDGET = Math.min(DESC_BUDGET, 4000);

    // Smarter Slicer
    const smartSlice = (s, limit) => {
      if (s.length <= limit) return s;
      const cut1 = s.lastIndexOf("\n\n", limit);
      const cut2 = s.lastIndexOf("\n", limit);
      const cut3 = s.lastIndexOf(" ", limit);
      const cut = Math.max(cut1, cut2, cut3, limit);
      return s.slice(0, cut).trim();
    };

    // In Embed-Beschreibungsteile splitten (unter Budget)
    const descChunks = [];
    let remaining = fullDesc;
    while (remaining.length > 0) {
      const part = smartSlice(remaining, DESC_BUDGET);
      descChunks.push(part);
      remaining = remaining.slice(part.length).trimStart();
      if (remaining.length && remaining[0] === "\n") remaining = remaining.slice(1);
    }

    // Embed-Factory mit finalem Check (Total <= 6000)
    const makeEmbed = (desc, addImage = false) => {
      // Falls desc doch zu groß (extreme Unicode-Fälle) → hart trimmen
      if (desc.length > HARD_DESC_MAX) desc = desc.slice(0, HARD_DESC_MAX);

      // finale Gesamtsumme prüfen; wenn nötig, desc nachtrimmen
      const totalLen = desc.length + authorName.length + footerText.length;
      const maxDescByTotal = Math.min(HARD_DESC_MAX, Math.max(0, HARD_EMBED_SUM - (authorName.length + footerText.length)));
      if (totalLen > HARD_EMBED_SUM && desc.length > maxDescByTotal) {
        desc = desc.slice(0, maxDescByTotal);
      }

      const embed = {
        color: themeColor,
        author: { name: authorName, icon_url: personaAvatarUrl || undefined },
        description: desc,
        timestamp: new Date().toISOString(),
        footer: { text: footerText }
      };
      if (addImage && firstImage?.url) {
        embed.image = { url: firstImage.url };
      }
      return embed;
    };

    // Embeds bauen, Bild nur im ersten
    const embeds = descChunks.map((d, i) => makeEmbed(d, i === 0));

    // In Paketen zu je 10 senden; wenn mehr → mehrere Nachrichten
    for (let i = 0; i < embeds.length; i += MAX_EMBEDS_PER_MSG) {
      const slice = embeds.slice(i, i + MAX_EMBEDS_PER_MSG);
      try {
        await hook.send({
          content: "",
          username: authorName,
          avatarURL: personaAvatarUrl || undefined,
          embeds: slice,
          allowedMentions: { parse: [] },
          threadId: isThread ? message.channel.id : undefined
        });
      } catch (err) {
        // Fallback: wenn trotz Vorsicht 50035 kommt, weiche auf Plain-Text (chunked) aus.
        const code = (err?.rawError?.code || err?.code || err?.status || "").toString();
        const msg = (err?.message || "");
        if (msg.includes("MAX_EMBED_SIZE_EXCEEDED") || msg.includes("BASE_TYPE_MAX_LENGTH") || code === "50035") {
          // Plain-Text Fallback
          const plain = descChunks.join("\n\n");
          await sendChunked(isThread ? message.channel : hookChannel, plain);
        } else {
          throw err;
        }
      }
    }
  } catch (err) {
    await reportError(err, message?.channel, "REPLY_WEBHOOK_EMBED");
    // letzter Fallback
    try { await sendChunked(message.channel, aiText); } catch {}
  }
}


/** TTS-Queueing */
function setEnqueueTTS(guildId, task) {
  return new Promise((resolve, reject) => {
    if (!queueMap.has(guildId)) queueMap.set(guildId, []);
    const q = queueMap.get(guildId);
    q.push({ task, resolve, reject });
    if (q.length === 1) setProcessTTSQueue(guildId);
  });
}
async function setProcessTTSQueue(guildId) {
  const q = queueMap.get(guildId);
  if (!q?.length) return;
  const { task, resolve, reject } = q[0];
  try { await task(); resolve(); } catch (err) { reject(err); }
  finally { q.shift(); if (q.length > 0) setProcessTTSQueue(guildId); }
}

/** TTS Hilfsfunktionen */
function getSplitTextToChunks(text, maxChars = 500) {
  const sentences = String(text || "").match(/[^.!?\n]+[.!?\n]?/g) || [String(text || "")];
  const chunks = []; let current = "";
  for (const s of sentences) {
    if ((current + s).length > maxChars) { if (current.trim()) chunks.push(current.trim()); current = s; }
    else current += s;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/** Voice-Capture + Transkription */
async function setStartListening(connection, guildId, guildTextChannels, client, onTranscript) {
  try {
    if (!connection || !guildId) return;

    if (!setStartListening.__captures) setStartListening.__captures = new Map();
    const captures = setStartListening.__captures;

    const SILENCE_MS        = Number(process.env.VOICE_SILENCE_MS || 1200);
    const MAX_UTTERANCE_MS  = Number(process.env.VOICE_MAX_UTTERANCE_MS || 15000);
    const MIN_WAV_BYTES     = 96000;
    const MIN_SNR_DB        = 8;
    const MIN_VOICED_RATIO  = 0.40;
    const MIN_VOICED_FRAMES = 15;
    const DUP_WINDOW_MS     = Number(process.env.VOICE_DUP_WINDOW_MS || 1500);

    const normText = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();

    const prev = activeRecordings.get(guildId);
    if (prev && prev !== connection) {
      try { prev.receiver?.speaking?.removeAllListeners("start"); } catch {}
    }
    activeRecordings.set(guildId, connection);

    const receiver = connection.receiver;
    if (!receiver) return;

    const getLatestTarget = async () => {
      const latestId = guildTextChannels.get(guildId);
      if (!latestId) return null;
      const ch = await client.channels.fetch(latestId).catch(() => null);
      return ch || null;
    };

    async function analyzeWav(filePath) {
      try {
        const buf = await fs.promises.readFile(filePath);
        if (!buf || buf.length <= 44) return { snrDb: 0, voicedRatio: 0, voicedFrames: 0, totalFrames: 0, usefulMs: 0 };
        const pcm = buf.subarray(44); const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
        const sr = 48000, frame = 960; const totalFrames = Math.floor(samples.length / frame);
        if (totalFrames <= 0) return { snrDb: 0, voicedRatio: 0, voicedFrames: 0, totalFrames: 0, usefulMs: 0 };
        const rmsList = new Array(totalFrames); const zcrList = new Array(totalFrames);
        for (let f = 0; f < totalFrames; f++) {
          const start = f * frame; let sumSq = 0, zc = 0, prev = samples[start];
          for (let i = 1; i < frame; i++) { const s = samples[start + i]; sumSq += s * s; if ((s >= 0 && prev < 0) || (s < 0 && prev >= 0)) zc++; prev = s; }
          const rms = Math.sqrt(sumSq / frame) / 32768; const zcr = zc / (frame - 1);
          rmsList[f] = rms; zcrList[f] = zcr;
        }
        const sortedRms = rmsList.slice().sort((a,b)=>a-b);
        const p = (arr, q) => arr[Math.max(0, Math.min(arr.length - 1, Math.floor((arr.length - 1) * q)))];
        const noise  = Math.max(1e-6, p(sortedRms, 0.2));
        const speech = Math.max(noise + 1e-6, p(sortedRms, 0.8));
        const snrDb  = 20 * Math.log10(speech / noise);
        let voiced = 0;
        for (let f = 0; f < totalFrames; f++) {
          const voicedLike = rmsList[f] > noise * 2 && zcrList[f] < 0.25;
          if (voicedLike) voiced++;
        }
        const voicedRatio  = voiced / totalFrames;
        const voicedFrames = voiced;
        const usefulMs     = voicedFrames * 20;
        return { snrDb, voicedRatio, voicedFrames, totalFrames, usefulMs };
      } catch { return { snrDb: 0, voicedRatio: 0, voicedFrames: 0, totalFrames: 0, usefulMs: 0 }; }
    }

    receiver.speaking.removeAllListeners("start");
    receiver.speaking.on("start", (userId) => {
      const key = `${guildId}:${userId}`;

      const existing = captures.get(key);
      if (existing?.opus) { try { existing.opus.destroy(); } catch {} }

      let killTimer = null;
      try {
        const opus = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS } });
        captures.set(key, { opus });

        const startedAtMs = Date.now();
        const pcm  = opus.pipe(new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 }));
        const pass = new PassThrough();
        const wavPromise = writePcmToWav(pass, { rate: 48000, channels: 1 });
        pcm.on("data", (chunk) => pass.write(chunk));

        killTimer = setTimeout(() => { try { opus.destroy(); } catch {} }, MAX_UTTERANCE_MS);

        let finished = false;
        const finishOnce = async () => {
          if (finished) return; finished = true;
          const cur = captures.get(key); if (cur?.opus === opus) captures.delete(key);
          if (killTimer) { clearTimeout(killTimer); killTimer = null; }
          pass.end();

          try {
            const { dir, file } = await wavPromise;
            const st = await fs.promises.stat(file).catch(() => null);
            if (!st || st.size < MIN_WAV_BYTES) return;

            const latestTarget = await getLatestTarget(); if (!latestTarget) return;

            let consentOk = true; try { consentOk = await hasVoiceConsent(userId, latestTarget.id); } catch {}
            if (!consentOk) return;

            const { snrDb, voicedRatio, voicedFrames } = await analyzeWav(file);
            if (snrDb < MIN_SNR_DB || voicedRatio < MIN_VOICED_RATIO || voicedFrames < MIN_VOICED_FRAMES) return;

            const text  = await getTranscription(file, "whisper-1", "auto");
            const clean = (text || "").trim(); if (!clean) return;

            const norm = normText(clean); const now  = Date.now();
            if (!setStartListening.__dups) setStartListening.__dups = new Map();
            const last = setStartListening.__dups.get(key);
            if (last && last.norm === norm && (now - last.ts) < DUP_WINDOW_MS) return;
            setStartListening.__dups.set(key, { norm, ts: now });

            const speaker = await resolveSpeakerName(client, guildId, userId);

            if (typeof onTranscript === "function") {
              await onTranscript({ guildId, channelId: latestTarget.id, userId, speaker, text: clean, startedAtMs });
            }
          } catch (err) {
            reportError(err, null, "TRANSCRIPTION_FLOW");
          } finally {
            try { const { dir } = await wavPromise; await fs.promises.rm(dir, { recursive: true, force: true }); } catch {}
            try { opus.removeAllListeners(); } catch {}
            try { pcm.removeAllListeners(); } catch {}
          }
        };

        opus.once("end",   () => finishOnce());
        opus.once("close", () => finishOnce());
        opus.once("error", () => finishOnce());
        pcm.once("end",    () => finishOnce());
        pcm.once("error",  () => finishOnce());

      } catch (err) {
        reportError(err, null, "VOICE_SUBSCRIBE");
        const cur = captures.get(key);
        if (cur?.opus) { try { cur.opus.removeAllListeners(); } catch {} }
        captures.delete(key);
        if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      }
    });

    connection.on("stateChange", (_oldS, newS) => {
      if (newS.status === "destroyed" || newS.status === "disconnected") {
        if (activeRecordings.get(guildId) === connection) activeRecordings.delete(guildId);
      }
    });
  } catch (err) {
    reportError(err, null, "SET_START_LISTENING");
  }
}

/** TTS abspielen */
async function getSpeech(connection, guildId, text, client, voice) {
  try {
    if (!connection || !text?.trim()) return;

    // WICHTIG: Links/URLs entfernen, nur Alt-/Link-Text vorlesen
    const prepared = prepareTextForTTS(text);

    const chunks = getSplitTextToChunks(prepared);

    return setEnqueueTTS(guildId, async () => {
      let player = playerMap.get(guildId);
      if (!player) {
        const { createAudioPlayer } = require("@discordjs/voice");
        player = createAudioPlayer();
        if (typeof player.setMaxListeners === "function") player.setMaxListeners(50);
        playerMap.set(guildId, player);
      }

      try { connection.subscribe(player); } catch {}

      const { AudioPlayerStatus } = require("@discordjs/voice");

      for (const chunk of chunks) {
        try {
          const response = await getTTS(chunk, "tts-1", voice);
          const pass = new (require("stream").PassThrough)();
          response.pipe(pass);

          const decoder = new prism.FFmpeg({ args: ["-i", "pipe:0", "-f", "s16le", "-ar", "48000", "-ac", "2"] });
          const pcmStream = pass.pipe(decoder);
          const { createAudioResource, StreamType } = require("@discordjs/voice");
          const resource = createAudioResource(pcmStream, { inputType: StreamType.Raw });

          await new Promise((resolve, reject) => {
            const onIdle = () => { cleanup(); resolve(); };
            const onError = (err) => { cleanup(); reject(err); };
            const cleanup = () => {
              try { player.off(AudioPlayerStatus.Idle, onIdle); } catch {}
              try { player.off("error", onError); } catch {}
            };
            player.on(AudioPlayerStatus.Idle, onIdle);
            player.on("error", onError);
            player.play(resource);
          });

          await new Promise(r => setTimeout(r, 100));
        } catch (err) {
          reportError(err, null, "TTS_CHUNK");
        }
      }
    });
  } catch (err) {
    reportError(err, null, "GET_SPEECH");
  }
}

function resetTTSPlayer(guildId) {
  try {
    const p = playerMap.get(guildId);
    if (p) { try { p.stop(true); } catch {} playerMap.delete(guildId); }
  } catch (err) { reportError(err, null, "RESET_TTS_PLAYER"); }
}
function resetRecordingFlag(guildId) {
  try { activeRecordings.delete(guildId); }
  catch (err) { reportError(err, null, "RESET_RECORDING_FLAG"); }
}

module.exports = {
  getChannelConfig,
  setMessageReaction,
  setReplyAsWebhook,
  splitIntoChunks,
  setAddUserMessage,
  sendChunked,
  setBotPresence,
  setStartListening,
  getSpeech,
  resetTTSPlayer,
  resetRecordingFlag,
  postSummariesIndividually,
  setReplyAsWebhookEmbed,
  ensureChannelAvatar,
  buildPublicAvatarUrl
};

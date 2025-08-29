// discord-helper.js — clean v2
// Minimal helper set for Discord bot: config loading, webhook replies (with chunked embeds), TTS, voice capture, and small utilities.

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
require("dotenv").config();

ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH || "/usr/bin/ffmpeg");

// State for voice & TTS
const activeRecordings = new Map();
const _avatarInFlight = new Map();
const queueMap = new Map();
const playerMap = new Map();

/* Build a concise visual prompt from persona text */
async function buildVisualPromptFromPersona(personaText) {
  const { getAI } = require("./aiService.js");
  const ctx = {
    messages: [
      {
        role: "system",
        content:
          "Convert an assistant persona into ONE concise visual prompt for a square avatar. " +
          "Be concrete: vibe/age, outfit, colors, expression, background. No text/logos/frames/brands. " +
          "End with 'square portrait, centered, neutral background, soft lighting'. ~80 words max."
      },
      {
        role: "user",
        content: "Persona:\n" + (personaText || "").trim() + "\n\nCreate the avatar prompt now."
      }
    ]
  };
  const prompt = (await getAI(ctx, 180, "gpt-4o"))?.trim();
  return prompt || "Friendly character portrait, square portrait, centered, neutral background, soft lighting";
}

/* Stop and dispose the TTS player for a guild */
function resetTTSPlayer(guildId) {
  try {
    const p = playerMap.get(guildId);
    if (p) {
      try { p.stop(true); } catch {}
      playerMap.delete(guildId);
    }
  } catch {}
}

/* Clear internal recording flag to arm capture on next join */
function resetRecordingFlag(guildId) {
  try { activeRecordings.delete(guildId); } catch {}
}

/* Ensure a channel avatar image exists (generated from persona) and return its URL */
async function ensureChannelAvatar(channelId, channelMeta) {
  try {
    const dir = path.join(__dirname, "documents", "avatars");
    const file = path.join(dir, `${channelId}.png`);
    if (fs.existsSync(file)) return `https://ralfreschke.de/documents/avatars/${channelId}.png`;

    const persona = (channelMeta?.persona || "").trim();
    if (!persona) return `https://ralfreschke.de/documents/avatars/default.png`;

    if (_avatarInFlight.has(channelId)) {
      await _avatarInFlight.get(channelId);
      return fs.existsSync(file)
        ? `https://ralfreschke.de/documents/avatars/${channelId}.png`
        : `https://ralfreschke.de/documents/avatars/default.png`;
    }

    const p = (async () => {
      await fs.promises.mkdir(dir, { recursive: true });
      const visualPrompt = await buildVisualPromptFromPersona(persona);
      const imageUrl = await getAIImage(visualPrompt, "1024x1024", "dall-e-3");
      const res = await axios.get(imageUrl, { responseType: "arraybuffer" });
      await fs.promises.writeFile(file, Buffer.from(res.data));
    })();

    _avatarInFlight.set(channelId, p);
    await p;
    _avatarInFlight.delete(channelId);

    return `https://ralfreschke.de/documents/avatars/${channelId}.png`;
  } catch (e) {
    console.warn("[ensureChannelAvatar] failed:", e?.response?.data || e?.message || e);
    _avatarInFlight.delete(channelId);
    return `https://ralfreschke.de/documents/avatars/default.png`;
  }
}

/* Load default persona/config from channel-config/default.json */
function getDefaultPersona() {
  const defaultPath = path.join(__dirname, "channel-config", "default.json");
  try {
    const data = fs.readFileSync(defaultPath, "utf8");
    const json = JSON.parse(data);
    return {
      persona: json.persona || "",
      instructions: json.instructions || "",
      voice: json.voice || "",
      name: json.name || "",
      botname: json.botname || "",
      selectedTools: json.tools || [],
      blocks: Array.isArray(json.blocks) ? json.blocks : [],
      summaryPrompt: json.summaryPrompt || json.summary_prompt || "",
      admins: Array.isArray(json.admins) ? json.admins : [],
      chatAppend: json.chatAppend || json.chatPrompt || json.chat_prompt || json.prompt_chat || "",
      speechAppend: json.speechAppend || json.speechPrompt || json.speech_prompt || json.prompt_speech || "",
      max_user_messages: json.max_user_messages ?? json.maxUserMessages ?? null,
      max_tokens_chat: json.max_tokens_chat ?? json.maxTokensChat,
      max_tokens_speaker: json.max_tokens_speaker ?? json.maxTokensSpeaker,
    };
  } catch {
    return {
      persona: "", instructions: "", voice: "", name: "", botname: "",
      selectedTools: [], blocks: [], summaryPrompt: "", admins: [],
      chatAppend: "", speechAppend: "",
      max_user_messages: null, max_tokens_chat: undefined, max_tokens_speaker: undefined,
    };
  }
}

/* Load merged channel config (default + per-channel JSON) */
function getChannelConfig(channelId) {
  const configPath = path.join(__dirname, "channel-config", `${channelId}.json`);
  const def = getDefaultPersona();

  let persona = def.persona || "";
  let instructions = def.instructions || "";
  let voice = def.voice || "";
  let name = def.name || "";
  let botname = def.botname || "AI";
  let selectedTools = def.selectedTools || def.tools || [];
  let blocks = Array.isArray(def.blocks) ? def.blocks : [];
  let summaryPrompt = def.summaryPrompt || def.summary_prompt || "";
  let max_user_messages = (Number.isFinite(Number(def.max_user_messages)) && Number(def.max_user_messages) >= 0)
    ? Number(def.max_user_messages)
    : null;
  let admins = Array.isArray(def.admins) ? def.admins.map(String) : [];

  let max_tokens_chat = (Number.isFinite(Number(def.max_tokens_chat)) && Number(def.max_tokens_chat) > 0)
    ? Math.floor(Number(def.max_tokens_chat)) : 4096;
  let max_tokens_speaker = (Number.isFinite(Number(def.max_tokens_speaker)) && Number(def.max_tokens_speaker) > 0)
    ? Math.floor(Number(def.max_tokens_speaker)) : 1024;

  let chatAppend = typeof def.chatAppend === "string" ? def.chatAppend.trim() : "";
  let speechAppend = typeof def.speechAppend === "string" ? def.speechAppend.trim() : "";

  const hasConfigFile = fs.existsSync(configPath);
  if (hasConfigFile) {
    try {
      const raw = fs.readFileSync(configPath, "utf8");
      const cfg = JSON.parse(raw);

      if (typeof cfg.voice === "string") voice = cfg.voice;
      if (typeof cfg.botname === "string") botname = cfg.botname;
      if (typeof cfg.name === "string") name = cfg.name;
      if (typeof cfg.persona === "string") persona = cfg.persona;
      if (typeof cfg.instructions === "string") instructions = cfg.instructions;
      if (Array.isArray(cfg.tools)) selectedTools = cfg.tools;
      if (Array.isArray(cfg.blocks)) blocks = cfg.blocks;

      if (typeof cfg.summaryPrompt === "string") summaryPrompt = cfg.summaryPrompt;
      else if (typeof cfg.summary_prompt === "string") summaryPrompt = cfg.summary_prompt;

      const rawMax = (cfg.max_user_messages ?? cfg.maxUserMessages);
      if (rawMax === null || rawMax === undefined || rawMax === "") {
        max_user_messages = null;
      } else {
        const n = Number(rawMax);
        max_user_messages = (Number.isFinite(n) && n >= 0) ? Math.floor(n) : null;
      }

      const rawTokChat = (cfg.max_tokens_chat ?? cfg.maxTokensChat);
      if (rawTokChat !== undefined && rawTokChat !== null && rawTokChat !== "") {
        const n = Number(rawTokChat);
        if (Number.isFinite(n) && n > 0) max_tokens_chat = Math.floor(n);
      }
      const rawTokSpk = (cfg.max_tokens_speaker ?? cfg.maxTokensSpeaker);
      if (rawTokSpk !== undefined && rawTokSpk !== null && rawTokSpk !== "") {
        const n = Number(rawTokSpk);
        if (Number.isFinite(n) && n > 0) max_tokens_speaker = Math.floor(n);
      }

      if (Array.isArray(cfg.admins)) admins = cfg.admins.map(String);

      const cfgChatAppend = cfg.chatAppend ?? cfg.chatPrompt ?? cfg.chat_prompt ?? cfg.prompt_chat ?? "";
      const cfgSpeechAppend = cfg.speechAppend ?? cfg.speechPrompt ?? cfg.speech_prompt ?? cfg.prompt_speech ?? "";

      if (typeof cfgChatAppend === "string") chatAppend = cfgChatAppend.trim();
      if (typeof cfgSpeechAppend === "string") speechAppend = cfgSpeechAppend.trim();
    } catch (e) {
      console.error(`[ERROR] Failed to parse channel config ${channelId}:`, e.message);
    }
  }

  const { registry: toolRegistry, tools: ctxTools } = getToolRegistry(selectedTools);

  const avatarPath = path.join(__dirname, "documents", "avatars", `${channelId}.png`);
  const avatarUrl = fs.existsSync(avatarPath)
    ? `https://ralfreschke.de/documents/avatars/${channelId}.png`
    : `https://ralfreschke.de/documents/avatars/default.png`;

  const summariesEnabled = !!(hasConfigFile && String(summaryPrompt || "").trim());

  return {
    name,
    botname,
    voice,
    persona,
    avatarUrl,
    instructions,
    tools: ctxTools,
    toolRegistry,
    blocks,
    summaryPrompt,
    max_user_messages,
    hasConfig: hasConfigFile,
    summariesEnabled,
    admins,
    max_tokens_chat,
    max_tokens_speaker,
    chatAppend,
    speechAppend,
  };
}

/* Split plain text into safe Discord message chunks (<=2000 chars) */
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

/* Send long content to a channel using chunking */
async function sendChunked(channel, content) {
  const parts = splitIntoChunks(content);
  for (const p of parts) {
    await channel.send({ content: p });
  }
}

/* Post a list of summaries as separate messages (with optional header) */
async function postSummariesIndividually(channel, summaries, headerPrefix = null) {
  for (let i = 0; i < summaries.length; i++) {
    const header =
      headerPrefix
        ? `${headerPrefix} ${i + 1}/${summaries.length}`
        : `**Summary ${i + 1}/${summaries.length}**`;
    await sendChunked(channel, `${header}\n\n${summaries[i]}`);
  }
}

/* Set or update the bot's Discord presence */
async function setBotPresence(client, activityText = "✅ Ready", status = "online", activityType = 0) {
  try {
    if (!client?.user) return;
    await client.user.setPresence({
      activities: [{ name: activityText, type: activityType }],
      status,
    });
  } catch (e) {
    console.warn("[presence] setBotPresence failed:", e?.message || e);
  }
}

/* Add the user message (and any attachments) into the chat context */
async function setAddUserMessage(message, chatContext) {
  try {
    const raw = (message?.content || "").trim();
    if (raw.startsWith("!")) return;

    let content = raw;
    if (message.attachments?.size > 0) {
      const links = [...message.attachments.values()].map(a => a.url).join("\n");
      content = `${links}\n${content}`.trim();
    }

    const senderName =
      message.member?.displayName ||
      message.author?.username ||
      "user";

    await chatContext.add("user", senderName, content);
  } catch (e) {
    console.warn("[setAddUserMessage] failed:", e?.message || e);
  }
}

/* Create a temp file path */
async function makeTmpFile(ext = ".wav") {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dgpt-"));
  const file = path.join(dir, `${Date.now()}${ext}`);
  return { dir, file };
}

/* Convert PCM stream to WAV using ffmpeg */
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
    } catch (e) {
      reject(e);
    }
  });
}

/* Resolve a member's display name for a guild */
async function resolveSpeakerName(client, guildId, userId) {
  try {
    const g = await client.guilds.fetch(guildId);
    const m = await g.members.fetch(userId).catch(() => null);
    return m?.displayName || m?.user?.username || "Unknown";
  } catch {
    return "Unknown";
  }
}

/* Add or replace a simple status reaction on a message (⏳/✅/❌) */
async function setMessageReaction(message, emoji) {
  const STATUS = ["⏳", "✅", "❌"];
  try {
    const me = message.client?.user;
    if (!me) return;

    const toRemove = message.reactions?.cache?.filter(r => STATUS.includes(r.emoji?.name)) || [];
    for (const r of toRemove.values()) {
      try { await r.users.remove(me.id); } catch {}
    }

    if (emoji && STATUS.includes(emoji)) {
      await message.react(emoji).catch(() => {});
    }
  } catch (e) {
    console.warn("[setMessageReaction] failed:", e?.message || e);
  }
}

/* Reply via webhook with text only (chunked as plain content) */
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
      hook = await hookChannel.createWebhook({
        name: botname || "AI",
        avatar: personaAvatarUrl || undefined,
      });
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
  } catch (e) {
    console.error("[Webhook Reply] failed:", e);
    await sendChunked(message.channel, content);
  }
}

/* Build a list of URLs (with optional labels) from text */
function collectUrlsWithLabels(text) {
  const out = [];
  const seen = new Set();

  const pushOnce = (url, label, kind, isImageExt) => {
    const clean = cleanUrl(url);
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    out.push({ url: clean, label: label || null, kind, isImageExt: !!isImageExt });
  };

  String(text || "").replace(/!\[([^\]]*)]\((https?:\/\/[^\s)]+)\)/g, (_m, alt, url) => {
    pushOnce(url, (alt || "").trim(), "md_image", looksLikeImage(url));
    return "";
  });

  String(text || "").replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => {
    pushOnce(url, (label || "").trim(), "md_link", looksLikeImage(url));
    return "";
  });

  String(text || "").replace(/https?:\/\/[^\s)]+/g, (url) => {
    pushOnce(url, null, "plain", looksLikeImage(url));
    return "";
  });

  return out;
}

/* Choose the best image candidate from a URL list */
async function pickFirstImageCandidate(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const mdImg = list.find(l => l.kind === "md_image");
  if (mdImg) return mdImg;
  const withExt = list.find(l => l.isImageExt);
  if (withExt) return withExt;

  for (const l of list) {
    try {
      const ct = await headContentType(l.url);
      if (ct && /^image\//i.test(ct)) return l;
    } catch {}
  }
  return null;
}

/* Get Content-Type using HEAD (fallback GET stream) */
async function headContentType(url) {
  try {
    const res = await axios.head(url, { maxRedirects: 5, timeout: 7000, validateStatus: null });
    const ct = res?.headers?.["content-type"] || res?.headers?.["Content-Type"];
    if (ct) return String(ct);
  } catch {}
  try {
    const res = await axios.get(url, { maxRedirects: 5, timeout: 8000, responseType: "stream", validateStatus: null });
    try { res.data?.destroy?.(); } catch {}
    const ct = res?.headers?.["content-type"] || res?.headers?.["Content-Type"];
    if (ct) return String(ct);
  } catch {}
  return null;
}

/* Normalize text for embed: turn markdown images into ordinary links, reduce spacing */
function prepareTextForEmbed(text) {
  let s = String(text || "");
  s = s.replace(/!\[([^\]]*)]\((https?:\/\/[^\s)]+)\)/g, (_m, alt, url) => {
    const a = String(alt || "").trim();
    return a ? `[${a}](${url})` : `<${url}>`;
  });
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return s;
}

/* Heuristic: URL looks like an image by extension */
function looksLikeImage(u) {
  return /\.(png|jpe?g|gif|webp|bmp|tiff?)($|\?|\#)/i.test(u);
}

/* Light URL cleanup (strip trailing bracket/commas) */
function cleanUrl(u) {
  try { return u.replace(/[),.]+$/g, ""); } catch { return u; }
}

/* Send AI reply as chunked embeds; first embed may include a large image */
async function setReplyAsWebhookEmbed(message, aiText, { botname, color } = {}) {
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
        avatar: personaAvatarUrl || undefined,
      });
    }

    const links = collectUrlsWithLabels(aiText);
    const firstImage = await pickFirstImageCandidate(links);
    const bodyText = prepareTextForEmbed(aiText);

    const rest = links.filter(l => !(firstImage && l.url === firstImage.url));
    const bulletsBlock = rest.length
      ? "\n\n**More links**\n" + rest.map(l => {
          const label = (l.label && l.label.trim()) ? l.label.trim() : null;
          return label ? `• ${label} — <${l.url}>` : `• <${l.url}>`;
        }).join("\n")
      : "";

    const themeColor = Number.isInteger(color) ? color : 0x5865F2;
    const MAX_EMBED = 4096;

    const fullDesc = (bodyText + bulletsBlock).trim();
    const descChunks = [];
    let remaining = fullDesc;

    const smartSlice = (s, limit) => {
      if (s.length <= limit) return s;
      const cut1 = s.lastIndexOf("\n\n", limit);
      const cut2 = s.lastIndexOf("\n", limit);
      const cut3 = s.lastIndexOf(" ", limit);
      const cut = Math.max(cut1, cut2, cut3, limit);
      return s.slice(0, cut).trim();
    };

    while (remaining.length > 0) {
      const part = smartSlice(remaining, MAX_EMBED);
      descChunks.push(part);
      remaining = remaining.slice(part.length).trimStart();
      if (remaining.length && remaining[0] === "\n") remaining = remaining.slice(1);
    }

    const makeEmbed = (desc, i, n) => ({
      color: themeColor,
      author: { name: botname || meta?.botname || "AI", icon_url: personaAvatarUrl || undefined },
      description: desc,
      timestamp: new Date().toISOString(),
      footer: { text: (meta?.name ? `${meta.name}` : (botname || meta?.botname || "AI")) + (n > 1 ? ` — Part ${i}/${n}` : "") }
    });

    const embeds = descChunks.map((d, idx) => makeEmbed(d, idx + 1, descChunks.length));
    if (firstImage?.url && embeds.length) {
      embeds[0].image = { url: firstImage.url };
    }

    for (let i = 0; i < embeds.length; i += 10) {
      const slice = embeds.slice(i, i + 10);
      await hook.send({
        content: "",
        username: botname || meta?.botname || "AI",
        avatarURL: personaAvatarUrl || undefined,
        embeds: slice,
        allowedMentions: { parse: [] },
        threadId: isThread ? message.channel.id : undefined
      });
    }
  } catch (e) {
    console.error("[Webhook Embed Reply] failed:", e);
    try { await sendChunked(message.channel, aiText); } catch {}
  }
}

/* Enqueue a TTS task to be played sequentially per guild (returns when finished) */
function setEnqueueTTS(guildId, task) {
  return new Promise((resolve, reject) => {
    if (!queueMap.has(guildId)) queueMap.set(guildId, []);
    const q = queueMap.get(guildId);
    q.push({ task, resolve, reject });
    if (q.length === 1) setProcessTTSQueue(guildId);
  });
}

/* Process the TTS queue for a guild */
async function setProcessTTSQueue(guildId) {
  const q = queueMap.get(guildId);
  if (!q?.length) return;
  const { task, resolve, reject } = q[0];
  try {
    await task();
    resolve();
  } catch (e) {
    reject(e);
  } finally {
    q.shift();
    if (q.length > 0) setProcessTTSQueue(guildId);
  }
}

/* Split text into smaller parts for TTS playback */
function getSplitTextToChunks(text, maxChars = 500) {
  const sentences = String(text || "").match(/[^.!?\n]+[.!?\n]?/g) || [String(text || "")];
  const chunks = [];
  let current = "";
  for (const s of sentences) {
    if ((current + s).length > maxChars) {
      if (current.trim()) chunks.push(current.trim());
      current = s;
    } else current += s;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/* Capture and transcribe users speaking in a voice channel, then callback with transcript */
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

    const normText = (s) =>
      String(s || "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();

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
        if (!buf || buf.length <= 44) {
          return { snrDb: 0, voicedRatio: 0, voicedFrames: 0, totalFrames: 0, usefulMs: 0 };
        }
        const pcm = buf.subarray(44);
        const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);

        const sr = 48000, frame = 960; // 20ms
        const totalFrames = Math.floor(samples.length / frame);
        if (totalFrames <= 0) return { snrDb: 0, voicedRatio: 0, voicedFrames: 0, totalFrames: 0, usefulMs: 0 };

        const rmsList = new Array(totalFrames);
        const zcrList = new Array(totalFrames);

        for (let f = 0; f < totalFrames; f++) {
          const start = f * frame;
          let sumSq = 0, zc = 0, prev = samples[start];
          for (let i = 1; i < frame; i++) {
            const s = samples[start + i];
            sumSq += s * s;
            if ((s >= 0 && prev < 0) || (s < 0 && prev >= 0)) zc++;
            prev = s;
          }
          const rms = Math.sqrt(sumSq / frame) / 32768;
          const zcr = zc / (frame - 1);
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
      } catch {
        return { snrDb: 0, voicedRatio: 0, voicedFrames: 0, totalFrames: 0, usefulMs: 0 };
      }
    }

    receiver.speaking.removeAllListeners("start");
    receiver.speaking.on("start", (userId) => {
      const key = `${guildId}:${userId}`;

      const existing = captures.get(key);
      if (existing?.opus) {
        try { existing.opus.destroy(); } catch {}
      }

      let killTimer = null;
      try {
        const opus = receiver.subscribe(userId, {
          end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
        });
        captures.set(key, { opus });

        const startedAtMs = Date.now();

        const pcm  = opus.pipe(new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 }));
        const pass = new PassThrough();
        const wavPromise = writePcmToWav(pass, { rate: 48000, channels: 1 });

        pcm.on("data", (chunk) => pass.write(chunk));

        killTimer = setTimeout(() => {
          try { opus.destroy(); } catch {}
        }, MAX_UTTERANCE_MS);

        let finished = false;
        const finishOnce = async () => {
          if (finished) return;
          finished = true;

          const cur = captures.get(key);
          if (cur?.opus === opus) captures.delete(key);

          if (killTimer) { clearTimeout(killTimer); killTimer = null; }
          pass.end();

          try {
            const { dir, file } = await wavPromise;

            const st = await fs.promises.stat(file).catch(() => null);
            if (!st || st.size < MIN_WAV_BYTES) return;

            const latestTarget = await getLatestTarget();
            if (!latestTarget) return;

            let consentOk = true;
            try { consentOk = await hasVoiceConsent(userId, latestTarget.id); } catch {}
            if (!consentOk) return;

            const { snrDb, voicedRatio, voicedFrames } = await analyzeWav(file);
            if (snrDb < MIN_SNR_DB || voicedRatio < MIN_VOICED_RATIO || voicedFrames < MIN_VOICED_FRAMES) return;

            const text  = await getTranscription(file, "whisper-1", "auto");
            const clean = (text || "").trim();
            if (!clean) return;

            const norm = normText(clean);
            const now  = Date.now();
            if (!setStartListening.__dups) setStartListening.__dups = new Map();
            const last = setStartListening.__dups.get(key);
            if (last && last.norm === norm && (now - last.ts) < DUP_WINDOW_MS) return;
            setStartListening.__dups.set(key, { norm, ts: now });

            const speaker = await resolveSpeakerName(client, guildId, userId);

            if (typeof onTranscript === "function") {
              await onTranscript({
                guildId,
                channelId: latestTarget.id,
                userId,
                speaker,
                text: clean,
                startedAtMs
              });
            }
          } catch (err) {
            console.warn("[Transcription] failed:", err?.message || err);
          } finally {
            try {
              const { dir } = await wavPromise;
              await fs.promises.rm(dir, { recursive: true, force: true });
            } catch {}
            try { opus.removeAllListeners(); } catch {}
            try { pcm.removeAllListeners(); } catch {}
          }
        };

        opus.once("end",   () => finishOnce());
        opus.once("close", () => finishOnce());
        opus.once("error", () => finishOnce());
        pcm.once("end",    () => finishOnce());
        pcm.once("error",  () => finishOnce());

      } catch (e) {
        console.warn("[Voice subscribe] failed:", e?.message || e);
        const cur = captures.get(key);
        if (cur?.opus) {
          try { cur.opus.removeAllListeners(); } catch {}
        }
        captures.delete(key);
        if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      }
    });

    connection.on("stateChange", (oldS, newS) => {
      if (newS.status === "destroyed" || newS.status === "disconnected") {
        if (activeRecordings.get(guildId) === connection) {
          activeRecordings.delete(guildId);
        }
      }
    });
  } catch (e) {
    console.warn("[setStartListening] failed:", e?.message || e);
  }
}

/* Generate speech from text and play it in sequence on a guild connection */
async function getSpeech(connection, guildId, text, client, voice) {
  if (!connection || !text?.trim()) return;
  const chunks = getSplitTextToChunks(text);

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
      } catch (e) {
        console.error("[TTS ERROR]:", e);
      }
    }
  });
}

module.exports = {
  getDefaultPersona,
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
};

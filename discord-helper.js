// discord-helper.js — refactored v2.2 (no default persona)
// Minimal helper set for Discord bot: config loading (channel-only), webhook replies (chunked embeds),
// TTS, voice capture, and small utilities. All logging via reportError.

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

// State for voice & TTS
const activeRecordings = new Map();
const _avatarInFlight = new Map();
const queueMap = new Map();
const playerMap = new Map();

/* Build a concise visual prompt from persona text */
async function buildVisualPromptFromPersona(personaText) {
  try {
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
  } catch (err) {
    await reportError(err, null, "BUILD_VISUAL_PROMPT", "WARN");
    return "Friendly character portrait, square portrait, centered, neutral background, soft lighting";
  }
}

/* Stop and dispose the TTS player for a guild */
function resetTTSPlayer(guildId) {
  try {
    const p = playerMap.get(guildId);
    if (p) {
      try { p.stop(true); } catch {}
      playerMap.delete(guildId);
    }
  } catch (err) {
    reportError(err, null, "RESET_TTS_PLAYER", "WARN");
  }
}

/* Clear internal recording flag to arm capture on next join */
function resetRecordingFlag(guildId) {
  try {
    activeRecordings.delete(guildId);
  } catch (err) {
    reportError(err, null, "RESET_RECORDING_FLAG", "WARN");
  }
}

/* Ensure a channel avatar image exists (generated from persona) and return its URL */
async function ensureChannelAvatar(channelId, channelMeta) {
  try {
    const dir = path.join(__dirname, "documents", "avatars");
    const file = path.join(dir, `${channelId}.png`);
    if (fs.existsSync(file)) return `${process.env.PUBLIC_BASE_URL || ""}/documents/avatars/${channelId}.png`.replace(/\/+$/,"").replace(/(?<=:)\/\//, "//");

    const persona = (channelMeta?.persona || "").trim();
    if (!persona) {
      // no persona → fallback default avatar
      return `${process.env.PUBLIC_BASE_URL || ""}/documents/avatars/default.png`.replace(/\/+$/,"").replace(/(?<=:)\/\//, "//");
    }

    if (_avatarInFlight.has(channelId)) {
      await _avatarInFlight.get(channelId);
      return fs.existsSync(file)
        ? `${process.env.PUBLIC_BASE_URL || ""}/documents/avatars/${channelId}.png`.replace(/\/+$/,"").replace(/(?<=:)\/\//, "//")
        : `${process.env.PUBLIC_BASE_URL || ""}/documents/avatars/default.png`.replace(/\/+$/,"").replace(/(?<=:)\/\//, "//");
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

    return `${process.env.PUBLIC_BASE_URL || ""}/documents/avatars/${channelId}.png`.replace(/\/+$/,"").replace(/(?<=:)\/\//, "//");
  } catch (err) {
    _avatarInFlight.delete(channelId);
    reportError(err, null, "ENSURE_CHANNEL_AVATAR", "WARN");
    return `${process.env.PUBLIC_BASE_URL || ""}/documents/avatars/default.png`.replace(/\/+$/,"").replace(/(?<=:)\/\//, "//");
  }
}

/* Load channel config ONLY from channel-config/<channelId>.json (no defaults) */
function getChannelConfig(channelId) {
  try {
    const cfgFile = path.join(__dirname, "channel-config", `${channelId}.json`);
    if (!fs.existsSync(cfgFile)) {
      // no config for this channel
      return {
        name: "", botname: "AI", voice: "",
        persona: "", avatarUrl: `${process.env.PUBLIC_BASE_URL || ""}/documents/avatars/default.png`.replace(/\/+$/,"").replace(/(?<=:)\/\//, "//"),
        instructions: "", tools: [], toolRegistry: {}, blocks: [],
        summaryPrompt: "", max_user_messages: null, hasConfig: false, summariesEnabled: false,
        admins: [], max_tokens_chat: 4096, max_tokens_speaker: 1024, chatAppend: "", speechAppend: "",
      };
    }

    const raw = fs.readFileSync(cfgFile, "utf8");
    const cfg = JSON.parse(raw);

    const name = typeof cfg.name === "string" ? cfg.name : "";
    const botname = typeof cfg.botname === "string" ? cfg.botname : "AI";
    const voice = typeof cfg.voice === "string" ? cfg.voice : "";
    const persona = typeof cfg.persona === "string" ? cfg.persona : "";
    const instructions = typeof cfg.instructions === "string" ? cfg.instructions : "";

    const selectedTools = Array.isArray(cfg.tools) ? cfg.tools : [];
    const blocks = Array.isArray(cfg.blocks) ? cfg.blocks : [];

    const summaryPrompt = typeof cfg.summaryPrompt === "string"
      ? cfg.summaryPrompt
      : (typeof cfg.summary_prompt === "string" ? cfg.summary_prompt : "");

    const rawMax = (cfg.max_user_messages ?? cfg.maxUserMessages);
    const max_user_messages =
      (rawMax === null || rawMax === undefined || rawMax === "")
        ? null
        : (Number.isFinite(Number(rawMax)) && Number(rawMax) >= 0 ? Math.floor(Number(rawMax)) : null);

    const max_tokens_chat = (() => {
      const x = (cfg.max_tokens_chat ?? cfg.maxTokensChat);
      const n = Number(x);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4096;
    })();

    const max_tokens_speaker = (() => {
      const x = (cfg.max_tokens_speaker ?? cfg.maxTokensSpeaker);
      const n = Number(x);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1024;
    })();

    const admins = Array.isArray(cfg.admins) ? cfg.admins.map(String) : [];

    const chatAppend = String(cfg.chatAppend ?? cfg.chatPrompt ?? cfg.chat_prompt ?? cfg.prompt_chat ?? "").trim();
    const speechAppend = String(cfg.speechAppend ?? cfg.speechPrompt ?? cfg.speech_prompt ?? cfg.prompt_speech ?? "").trim();

    const { registry: toolRegistry, tools: ctxTools } = getToolRegistry(selectedTools);

    const avatarPath = path.join(__dirname, "documents", "avatars", `${channelId}.png`);
    const avatarUrl = fs.existsSync(avatarPath)
      ? `${process.env.PUBLIC_BASE_URL || ""}/documents/avatars/${channelId}.png`.replace(/\/+$/,"").replace(/(?<=:)\/\//, "//")
      : `${process.env.PUBLIC_BASE_URL || ""}/documents/avatars/default.png`.replace(/\/+$/,"").replace(/(?<=:)\/\//, "//");

    const summariesEnabled = !!String(summaryPrompt || "").trim();

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
      hasConfig: true,
      summariesEnabled,
      admins,
      max_tokens_chat,
      max_tokens_speaker,
      chatAppend,
      speechAppend,
    };
  } catch (err) {
    reportError(err, null, "GET_CHANNEL_CONFIG", "ERROR");
    return {
      name: "", botname: "AI", voice: "", persona: "",
      avatarUrl: `${process.env.PUBLIC_BASE_URL || ""}/documents/avatars/default.png`.replace(/\/+$/,"").replace(/(?<=:)\/\//, "//"),
      instructions: "", tools: [], toolRegistry: {}, blocks: [], summaryPrompt: "",
      max_user_messages: null, hasConfig: false, summariesEnabled: false, admins: [],
      max_tokens_chat: 4096, max_tokens_speaker: 1024, chatAppend: "", speechAppend: "",
    };
  }
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
  try {
    const parts = splitIntoChunks(content);
    for (const p of parts) {
      await channel.send({ content: p });
    }
  } catch (err) {
    await reportError(err, channel, "SEND_CHUNKED", "WARN");
  }
}

/* Post a list of summaries as separate messages (with optional header) */
async function postSummariesIndividually(channel, summaries, headerPrefix = null) {
  try {
    for (let i = 0; i < summaries.length; i++) {
      const header =
        headerPrefix
          ? `${headerPrefix} ${i + 1}/${summaries.length}`
          : `**Summary ${i + 1}/${summaries.length}**`;
      await sendChunked(channel, `${header}\n\n${summaries[i]}`);
    }
  } catch (err) {
    await reportError(err, channel, "POST_SUMMARIES", "WARN");
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
  } catch (err) {
    reportError(err, null, "SET_BOT_PRESENCE", "WARN");
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
  } catch (err) {
    await reportError(err, message?.channel, "SET_ADD_USER_MESSAGE", "WARN");
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
    } catch (err) {
      reject(err);
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
  try {
    const STATUS = ["⏳", "✅", "❌"];
    const me = message.client?.user;
    if (!me) return;

    const toRemove = message.reactions?.cache?.filter(r => STATUS.includes(r.emoji?.name)) || [];
    for (const r of toRemove.values()) {
      try { await r.users.remove(me.id); } catch {}
    }

    if (emoji && STATUS.includes(emoji)) {
      await message.react(emoji).catch(() => {});
    }
  } catch (err) {
    await reportError(err, message?.channel, "SET_MESSAGE_REACTION", "WARN");
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
  } catch (err) {
    await reportError(err, message?.channel, "REPLY_WEBHOOK", "WARN");
    try { await sendChunked(message.channel, content); } catch {}
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

  // Fallback: probe Content-Type (best-effort)
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

/* Light URL cleanup */
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
  } catch (err) {
    await reportError(err, message?.channel, "REPLY_WEBHOOK_EMBED", "WARN");
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
  } catch (err) {
    reject(err);
  } finally {
    q.shift();
    if (q.length > 0) setProcessTTSQueue(guildId);
  }
}

/* Split text into smaller parts for TTS playback  */
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
            // In voice pipeline we might not have a channel available → no channel param
            reportError(err, null, "TRANSCRIPTION_FLOW", "WARN");
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

      } catch (err) {
        reportError(err, null, "VOICE_SUBSCRIBE", "ERROR");
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
  } catch (err) {
    reportError(err, null, "SET_START_LISTENING", "ERROR");
  }
}

/* Generate speech from text and play it in sequence on a guild connection */
async function getSpeech(connection, guildId, text, client, voice) {
  try {
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
        } catch (err) {
          reportError(err, null, "TTS_CHUNK", "WARN");
        }
      }
    });
  } catch (err) {
    reportError(err, null, "GET_SPEECH", "ERROR");
  }
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
};

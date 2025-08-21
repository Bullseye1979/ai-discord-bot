// discord-helper.js — v1.8
// Hilfsfunktionen: Tools, Channel-Config, Chunking, Summaries, Transcripts-Thread
// Updates: sendChunked() gibt Message-Objekte zurück; setAddUserMessage loggt Bot/Webhook als assistant.

const fs = require("fs");
const path = require("path");
const { tools, getToolRegistry } = require("./tools.js");
const { EndBehaviorType } = require("@discordjs/voice");
const {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
} = require("@discordjs/voice");
const { ChannelType } = require("discord.js");
const { PassThrough } = require("stream");
const prism = require("prism-media");
const ffmpeg = require("fluent-ffmpeg");
const { getTranscription, getTTS } = require("./aiService.js");
require("dotenv").config();

ffmpeg.setFfmpegPath("/usr/bin/ffmpeg");

const queueMap = new Map();
const playerMap = new Map();

// ---------- Tools für User/Blocks ----------
function getUserTools(nameOrDisplayName) {
  const configPath = path.join(__dirname, "permissions.json");
  const raw = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "{}";
  const parsed = JSON.parse(raw || "{}");

  const defaultTools = parsed.default?.tools || [];
  const userTools = parsed.users?.[nameOrDisplayName]?.tools;

  const toolNames = Array.isArray(userTools) ? userTools : defaultTools;
  const activeTools = tools.filter((t) => toolNames.includes(t.function.name));
  const { registry: toolRegistry } = getToolRegistry(toolNames);

  return { tools: activeTools, toolRegistry };
}

// ---------- Default Persona (optional Fallback) ----------
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
    };
  } catch {
    return {
      persona: "",
      instructions: "",
      voice: "",
      name: "",
      botname: "",
      selectedTools: [],
      blocks: [],
      summaryPrompt: "",
    };
  }
}

// ---------- Channel-Config ----------
function getChannelConfig(channelId) {
  const configPath = path.join(__dirname, "channel-config", `${channelId}.json`);
  const def = getDefaultPersona();

  let {
    persona = def.persona,
    instructions = def.instructions,
    voice = def.voice,
    name = def.name,
    botname = def.botname,
    selectedTools = def.selectedTools,
    blocks = def.blocks,
    summaryPrompt = def.summaryPrompt,
  } = def;

  if (fs.existsSync(configPath)) {
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
    } catch (e) {
      console.error(`[ERROR] Failed to parse channel config ${channelId}:`, e.message);
    }
  }

  const { registry: toolRegistry, tools: ctxTools } = getToolRegistry(selectedTools);

  const avatarPath = path.join(__dirname, "documents", "avatars", `${channelId}.png`);
  const avatarUrl = fs.existsSync(avatarPath)
    ? `https://ralfreschke.de/documents/avatars/${channelId}.png`
    : `https://ralfreschke.de/documents/avatars/default.png`;

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
  };
}

// ---------- Chunking & Senden ----------
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

/**
 * Sendet Text (Chunked) und gibt ein Array der gesendeten Message-Objekte zurück.
 * @param {*} channel
 * @param {string} content
 * @returns {Promise<Array<import('discord.js').Message>>}
 */
async function sendChunked(channel, content) {
  const parts = splitIntoChunks(content);
  const sent = [];
  for (const p of parts) {
    try {
      const msg = await channel.send({ content: p });
      sent.push(msg);
    } catch (e) {
      console.warn("[sendChunked] Failed to send part:", e.message);
    }
  }
  return sent;
}

// summaries: Array<string> (älteste → neueste)
async function postSummariesIndividually(channel, summaries) {
  for (let i = 0; i < summaries.length; i++) {
    const header = `**Summary ${i + 1}/${summaries.length}**`;
    await sendChunked(channel, `${header}\n\n${summaries[i]}`);
  }
}

// ---------- Transcripts-Thread ----------
async function findExistingTranscriptsThread(channel) {
  try {
    const active = await channel.threads.fetchActive();
    const found = active?.threads?.find((t) => t.name === "Transcripts");
    if (found) return found;
  } catch (e) {}
  try {
    const archived = await channel.threads.fetchArchived();
    const foundA = archived?.threads?.find((t) => t.name === "Transcripts");
    if (foundA) return foundA;
  } catch (e) {}
  return null;
}

async function getOrCreateTranscriptsThread(channel) {
  const existing = await findExistingTranscriptsThread(channel);
  if (existing) return existing;

  try {
    const thread = await channel.threads.create({
      name: "Transcripts",
      autoArchiveDuration: 1440,
      reason: "Store voice transcripts and AI copies",
      type: 11, // ChannelType.PublicThread (avoid importing enum)
    });
    return thread;
  } catch (e) {
    console.warn("[Transcripts] Failed to create thread:", e.message);
    return null;
  }
}

async function sendToTranscriptsThread(channel, content, createIfMissing = false) {
  try {
    let thread = await findExistingTranscriptsThread(channel);
    if (!thread && createIfMissing) {
      thread = await getOrCreateTranscriptsThread(channel);
    }
    if (!thread) return false;

    const parts = splitIntoChunks(content);
    for (const p of parts) {
      await thread.send({ content: p });
    }
    return true;
  } catch (e) {
    console.warn("[Transcripts] Failed to send to thread:", e.message);
    return false;
  }
}

async function postTranscript(channel, text) {
  return sendToTranscriptsThread(channel, text, true);
}

// ---------- Status/Bots ----------
async function setBotPresence(client, activityText, status, activityType = 4) {
  if (client?.user) {
    await client.user.setPresence({
      activities: [{ name: activityText, type: activityType }],
      status,
    });
  }
}

// ---------- Kontext / Messages ----------
async function setAddUserMessage(message, chatContext) {
  // Befehle nie loggen
  const txt = message.content || "";
  if (txt.startsWith("!context") || txt.startsWith("!summarize")) return;

  // Bot/Webhook -> als assistant loggen; sonst user
  const isBotLike = !!message.author?.bot || !!message.webhookId;
  const role = isBotLike ? "assistant" : "user";

  let content = txt;
  if (message.attachments?.size > 0) {
    const links = message.attachments.map((a) => a.url).join("\n");
    content = `${links}\n${content}`;
  }
  const senderName =
    message.member?.displayName ||
    message.author?.username ||
    (isBotLike ? "bot" : "user");

  await chatContext.add(role, senderName, content);
}

// ---------- Voice-TTS (optional) ----------
function setEnqueueTTS(guildId, task) {
  if (!queueMap.has(guildId)) queueMap.set(guildId, []);
  const q = queueMap.get(guildId);
  q.push(task);
  if (q.length === 1) setProcessTTSQueue(guildId);
}

async function setProcessTTSQueue(guildId) {
  const q = queueMap.get(guildId);
  if (!q?.length) return;
  const task = q[0];
  try {
    await task();
  } catch (e) {
    console.error("[ERROR]:", e);
  } finally {
    q.shift();
    if (q.length > 0) setProcessTTSQueue(guildId);
  }
}

function getSplitTextToChunks(text, maxChars = 500) {
  const sentences = text.match(/[^.!?\n]+[.!?\n]?/g) || [text];
  const chunks = [];
  let current = "";
  for (const s of sentences) {
    if ((current + s).length > maxChars) {
      chunks.push(current.trim());
      current = s;
    } else current += s;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function getSpeech(connection, guildId, text, client, voice) {
  if (!connection || !text?.trim()) return;
  const chunks = getSplitTextToChunks(text);
  setEnqueueTTS(guildId, async () => {
    let player = playerMap.get(guildId);
    if (!player) {
      player = createAudioPlayer();
      playerMap.set(guildId, player);
      connection.subscribe(player);
    }
    for (const chunk of chunks) {
      try {
        const response = await getTTS(chunk, "tts-1", voice);
        const pass = new PassThrough();
        response.pipe(pass);
        const decoder = new prism.FFmpeg({
          args: ["-i", "pipe:0", "-f", "s16le", "-ar", "48000", "-ac", "2"],
        });
        const pcmStream = pass.pipe(decoder);
        const resource = createAudioResource(pcmStream, {
          inputType: StreamType.Raw,
        });
        player.play(resource);
        await new Promise((resolve, reject) => {
          player.once(AudioPlayerStatus.Idle, resolve);
          player.once("error", reject);
        });
        await new Promise((r) => setTimeout(r, 100));
      } catch (e) {
        console.error("[TTS ERROR]:", e);
      }
    }
  });
}

module.exports = {
  getUserTools,
  getDefaultPersona,
  getChannelConfig,
  setBotPresence,
  setAddUserMessage,
  splitIntoChunks,
  sendChunked,
  postSummariesIndividually,
  // Transcripts
  findExistingTranscriptsThread,
  getOrCreateTranscriptsThread,
  sendToTranscriptsThread,
  postTranscript,
  // TTS
  getSpeech,
};

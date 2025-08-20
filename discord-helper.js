// discord-helper.js — v1.5
// Hilfsfunktionen für Discord + Chunking + Summaries-Posting (einzeln)
// WICHTIG: getChannelConfig() liefert jetzt auch summaryPrompt zurück.

const fs = require("fs");
const path = require("path");
const { tools, getToolRegistry } = require("./tools.js");
const { EndBehaviorType } = require("@discordjs/voice");
const { createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } = require("@discordjs/voice");
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

// ---------- Default Persona (falls genutzt) ----------
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
      summaryPrompt: json.summaryPrompt || json.summary_prompt || "" // <— NEU: Fallback aus default.json (falls vorhanden)
    };
  } catch {
    return { persona: "", instructions: "", voice: "", name: "", botname: "", selectedTools: [], blocks: [], summaryPrompt: "" };
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
    summaryPrompt = def.summaryPrompt // <— NEU: initialer Wert
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

      // ✨ NEU: summaryPrompt aus der Channel-Config übernehmen (camelCase oder snake_case)
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
    blocks,          // Berechtigungen
    summaryPrompt    // <— WICHTIG: jetzt verfügbar für bot.js / context.js
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

async function sendChunked(channel, content) {
  const parts = splitIntoChunks(content);
  for (const p of parts) {
    await channel.send({ content: p });
  }
}

// summaries: Array<string> (älteste -> neueste), leftover?: string
async function postSummariesIndividually(channel, summaries, leftover) {
  for (let i = 0; i < summaries.length; i++) {
    const header = `**Summary ${i + 1}/${summaries.length}**`;
    await sendChunked(channel, `${header}\n\n${summaries[i]}`);
  }
  if (leftover && leftover.trim()) {
    await sendChunked(channel, `**Messages after cutoff (not summarized):**\n\n${leftover.trim()}`);
  }
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
  let content = message.content || "";
  if (message.attachments?.size > 0) {
    const links = message.attachments.map((a) => a.url).join("\n");
    content = `${links}\n${content}`;
  }
  const senderName = message.member?.displayName || message.author?.username || "user";
  await chatContext.add("user", senderName, content);
}

// ---------- Voice (falls genutzt) ----------
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
      const { createAudioPlayer } = require("@discordjs/voice");
      player = createAudioPlayer();
      playerMap.set(guildId, player);
      connection.subscribe(player);
    }
    for (const chunk of chunks) {
      try {
        const response = await getTTS(chunk, "tts-1", voice);
        const pass = new PassThrough();
        response.pipe(pass);
        const decoder = new prism.FFmpeg({ args: ["-i", "pipe:0", "-f", "s16le", "-ar", "48000", "-ac", "2"] });
        const pcmStream = pass.pipe(decoder);
        const resource = createAudioResource(pcmStream, { inputType: StreamType.Raw });
        player.play(resource);
        await new Promise((resolve, reject) => {
          player.once(AudioPlayerStatus.Idle, resolve);
          player.once("error", reject);
        });
        await new Promise((r) => setTimeout(r, 100));
      } catch (e) {
        console.error("[ERROR]:", e);
      }
    }
  });
}

module.exports = {
  getUserTools,
  getDefaultPersona,
  getChannelConfig,     // <- liefert summaryPrompt jetzt mit
  setBotPresence,
  setAddUserMessage,
  splitIntoChunks,
  sendChunked,
  postSummariesIndividually,
};

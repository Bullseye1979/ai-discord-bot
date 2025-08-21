// discord-helper.js — v1.8
// Voice (TTS + optional Transcripts-Thread), Chunking, Webhook-Replies, Channel-Config (inkl. summaryPrompt)

const fs = require("fs");
const path = require("path");
const { tools, getToolRegistry } = require("./tools.js");
const { EndBehaviorType, createAudioResource, StreamType } = require("@discordjs/voice");
const { PassThrough } = require("stream");
const prism = require("prism-media");
const ffmpeg = require("fluent-ffmpeg");
const { getTranscription, getTTS } = require("./aiService.js");
require("dotenv").config();

ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH || "/usr/bin/ffmpeg");

const activeRecordings = new Map();

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

// ---------- Default Persona ----------
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
      summaryPrompt: json.summaryPrompt || json.summary_prompt || ""
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
    summaryPrompt = def.summaryPrompt
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
    summaryPrompt
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

async function postSummariesIndividually(channel, summaries, _leftover) {
  for (let i = 0; i < summaries.length; i++) {
    const header = `**Summary ${i + 1}/${summaries.length}**`;
    await sendChunked(channel, `${header}\n\n${summaries[i]}`);
  }
}

// ---------- Webhook Reply ----------
async function setReplyAsWebhook(message, content, { botname, avatarUrl }) {
  try {
    const hooks = await message.channel.fetchWebhooks();
    let hook = hooks.find((w) => w.name === botname);
    if (!hook) {
      hook = await message.channel.createWebhook({
        name: botname || "AI"
      });
    }
    const parts = splitIntoChunks(content);
    for (const p of parts) {
      await hook.send({
        content: p,
        username: botname || "AI",
        avatarURL: avatarUrl || undefined,
        allowedMentions: { parse: [] }
      });
    }
  } catch (e) {
    console.error("[Webhook Reply] failed:", e);
    // Fallback ohne Webhook
    await sendChunked(message.channel, content);
  }
}

async function setMessageReaction(message, emoji) {
  try { await message.react(emoji); } catch {}
}

// ---------- Transcripts-Thread ----------
async function getOrCreateTranscriptsThread(textChannel) {
  try {
    const active = await textChannel.threads.fetchActive();
    let thread = active?.threads?.find(t => t.name === "Transcripts");
    if (thread) return thread;

    const archived = await textChannel.threads.fetchArchived();
    thread = archived?.threads?.find(t => t.name === "Transcripts");
    if (thread) {
      try { await thread.setArchived(false); } catch {}
      return thread;
    }

    // neu anlegen
    thread = await textChannel.threads.create({
      name: "Transcripts",
      autoArchiveDuration: 1440, // 24h
      reason: "Collecting voice transcripts"
    });
    return thread;
  } catch (e) {
    console.error("[Transcripts] create/fetch failed:", e.message);
    return null;
  }
}

// ---------- Voice: TTS ----------
const queueMap = new Map();
const playerMap = new Map();

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
    console.error("[TTS ERROR]:", e);
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

// ---------- Presence ----------

async function setBotPresence(client, activityText = "✅ Ready", status = "online", activityType = 0) {
  try {
    if (!client?.user) return;
    await client.user.setPresence({
      activities: [{ name: activityText, type: activityType }], // 0 = Playing
      status, // "online" | "idle" | "dnd" | "invisible"
    });
  } catch (e) {
    console.warn("[presence] setBotPresence failed:", e?.message || e);
  }
}


// ---------- Kontext / Messages ----------
async function setAddUserMessage(message, chatContext) {
  try {
    // Nichts loggen, wenn es die Kontext-Abfrage ist – die soll NICHT im Kontext/DB landen
    const raw = message?.content || "";
    if (raw.startsWith("!context")) return;

    // Anhänge sammeln
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


async function setStartListening(connection, guildId, guildTextChannels, client) {
  try {
    if (!connection || !guildId) return;
    if (activeRecordings.get(guildId)) return; // schon aktiv
    const textChannelId = guildTextChannels.get(guildId);
    const textChannel = textChannelId ? await client.channels.fetch(textChannelId).catch(() => null) : null;
    if (!textChannel) return;

    const thread = await getOrCreateTranscriptsThread(textChannel);
    const target = thread || textChannel;

    const receiver = connection.receiver;
    if (!receiver) return;

    activeRecordings.set(guildId, true);

    receiver.speaking.on("start", (userId) => {
      try {
        const opus = receiver.subscribe(userId, {
          end: { behavior: EndBehaviorType.AfterSilence, duration: 800 }
        });

        const pcm = opus.pipe(new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 }));
        const chunks = [];
        pcm.on("data", (c) => chunks.push(c));
        pcm.on("end", async () => {
          try {
            const buf = Buffer.concat(chunks);
            if (buf.length < 48000) return; // zu kurz -> ignorieren

            // Sprache erkennen (Passe Sprache/Signatur an deine aiService.js an)
            const text = await getTranscription(buf, "whisper-1", "auto");
            if (text && text.trim()) {
              // Sprechernamen ermitteln
              let speaker = "Unknown";
              try {
                const g = await client.guilds.fetch(guildId);
                const m = await g.members.fetch(userId).catch(() => null);
                speaker = m?.displayName || m?.user?.username || speaker;
              } catch {}

              await sendChunked(target, `**${speaker}:** ${text.trim()}`);
            }
          } catch (err) {
            console.warn("[Transcription] failed:", err?.message || err);
          }
        });
      } catch (e) {
        console.warn("[Voice subscribe] failed:", e?.message || e);
      }
    });

    // Aufräumen
    connection.on("stateChange", (oldS, newS) => {
      if (newS.status === "destroyed" || newS.status === "disconnected") {
        activeRecordings.delete(guildId);
      }
    });
  } catch (e) {
    console.warn("[setStartListening] failed:", e?.message || e);
  }
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
          const { AudioPlayerStatus } = require("@discordjs/voice");
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
  setMessageReaction,
  setReplyAsWebhook,
  splitIntoChunks,
  setAddUserMessage,
  sendChunked,
  setBotPresence,
  postSummariesIndividually,
  getOrCreateTranscriptsThread,
  setStartListening,
  getSpeech,
};

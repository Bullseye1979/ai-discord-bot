// discord-helper.js — v1.8
// Voice (TTS + optional Transcripts-Thread), Chunking, Webhook-Replies, Channel-Config (inkl. summaryPrompt)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { tools, getToolRegistry } = require("./tools.js");
const { EndBehaviorType, createAudioResource, StreamType } = require("@discordjs/voice");
const { PassThrough } = require("stream");
const { hasVoiceConsent } = require("./consent.js");
const prism = require("prism-media");
const ffmpeg = require("fluent-ffmpeg");
const axios = require("axios");
const { getAIImage, getTranscription, getTTS } = require("./aiService.js");
require("dotenv").config();

ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH || "/usr/bin/ffmpeg");

const activeRecordings = new Map();
const _avatarInFlight = new Map(); // ⬅️ verhindert parallele Generierungen
const transcriptWebhookCache = new Map(); // key: parentChannelId -> webhook

// --- Dedup/Locks für Voice ---
const capturingUsers = new Set();              // key = `${guildId}:${userId}` -> vermeidet parallele Captures
const lastUtteranceMap = new Map();            // key -> { norm, ts }
const DUP_WINDOW_MS = 5000;                    // 5s Fenster für 1:1-Dubletten

function normText(s = "") {
  return String(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "") // Satzzeichen raus
    .replace(/\s+/g, " ")
    .trim();
}

// --- Persona → Visual-Prompt (per GPT) ---
async function buildVisualPromptFromPersona(personaText) {
  // local require avoids rare binding issues
  const { getAI } = require("./aiService.js");

  const ctx = {
    messages: [
      {
        role: "system",
        content:
          "You convert assistant persona descriptions into ONE concise visual prompt for a clean square avatar illustration. " +
          "Only output the final prompt text. Be concrete: age vibe, outfit, color palette, expression, background. " +
          "Avoid any mention of text, logos, UI, frames, watermarks, brands. " +
          "End with: 'square portrait, centered, neutral background, soft lighting'. Max ~80 words."
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

function resetTTSPlayer(guildId) {
  try {
    const p = playerMap.get(guildId);
    if (p) {
      try { p.stop(true); } catch {}
      playerMap.delete(guildId);
    }
  } catch {}
}

function resetRecordingFlag(guildId) {
  // Aufnahme-Flag löschen, damit setStartListening beim nächsten Join neu scharf geschaltet wird
  try { activeRecordings.delete(guildId); } catch {}
}


// --- Avatar sicherstellen (nur Persona verwenden) ---
async function ensureChannelAvatar(channelId, channelMeta) {
  try {
    const dir = path.join(__dirname, "documents", "avatars");
    const file = path.join(dir, `${channelId}.png`);

    // Bereits vorhanden? -> URL zurück
    if (fs.existsSync(file)) {
      return `https://ralfreschke.de/documents/avatars/${channelId}.png`;
    }

    // Ohne Persona -> Default
    const persona = (channelMeta?.persona || "").trim();
    if (!persona) {
      return `https://ralfreschke.de/documents/avatars/default.png`;
    }

    // Parallel-Läufe verhindern
    if (_avatarInFlight.has(channelId)) {
      await _avatarInFlight.get(channelId);
      return fs.existsSync(file)
        ? `https://ralfreschke.de/documents/avatars/${channelId}.png`
        : `https://ralfreschke.de/documents/avatars/default.png`;
    }

    const p = (async () => {
      await fs.promises.mkdir(dir, { recursive: true });

      // 1) Persona → kompakten Bild-Prompt bauen
      const visualPrompt = await buildVisualPromptFromPersona(persona);

      // 2) Bild generieren
      const imageUrl = await getAIImage(visualPrompt, "1024x1024", "dall-e-3");

      // 3) Download & speichern
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

// WAV auf max. Bytes kürzen (48 kHz, 16-bit, mono ≈ 96,000 B/s)
async function trimWavToMaxBytes(file, { rate = 48000, channels = 1, maxBytes = 23 * 1024 * 1024 } = {}) {
  try {
    const st = await fs.promises.stat(file).catch(() => null);
    if (!st || st.size <= maxBytes) return file;

    const BYTES_PER_SEC = rate * channels * 2; // 16-bit PCM
    let maxSec = Math.floor((maxBytes - 44) / BYTES_PER_SEC) - 1; // Header abziehen + Puffer
    if (maxSec < 1) return null;

    const out = path.join(path.dirname(file), `trim_${Date.now()}.wav`);
    await new Promise((resolve, reject) => {
      ffmpeg(file)
        .audioCodec("pcm_s16le")
        .format("wav")
        .outputOptions([`-t ${maxSec}`])
        .save(out)
        .on("end", resolve)
        .on("error", reject);
    });
    return out;
  } catch {
    return file;
  }
}

// WAV auf eine feste Dauer (Sekunden) trimmen
async function trimWavToSeconds(file, seconds) {
  try {
    if (!Number.isFinite(seconds) || seconds <= 0) return file;
    const out = path.join(path.dirname(file), `crop_${Date.now()}.wav`);
    await new Promise((resolve, reject) => {
      ffmpeg(file)
        .audioCodec("pcm_s16le")
        .format("wav")
        .outputOptions([`-t ${seconds}`])
        .save(out)
        .on("end", resolve)
        .on("error", reject);
    });
    return out;
  } catch {
    return file;
  }
}

// Bestimme, wie viele Sekunden vom Anfang wir behalten, um höchstens maxVoiceSeconds "voiced" zu enthalten
// (Frame-basiert, 20 ms Frames @ 48 kHz; wir summieren voiced-Frames und stoppen, wenn Limit erreicht)
async function computeVoiceCropSeconds(file, {
  rate = 48000,
  frameSamples = 960,         // 20 ms
  maxVoiceSeconds = 12,       // z.B. 12s verwertbare Sprache
  padLeadSec = 0.20,          // kleiner Vorlauf
  padTailSec = 0.35           // kleiner Nachlauf
} = {}) {
  try {
    const buf = await fs.promises.readFile(file);
    if (!buf || buf.length <= 44) return null;

    const pcm = buf.subarray(44);
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
    const totalFrames = Math.floor(samples.length / frameSamples);
    if (totalFrames <= 0) return null;

    // einfache voiced-Heuristik wie unten in analyzeWav
    const rmsList = new Array(totalFrames);
    const zcrList = new Array(totalFrames);

    for (let f = 0; f < totalFrames; f++) {
      const start = f * frameSamples;
      let sumSq = 0, zc = 0, prev = samples[start];
      for (let i = 1; i < frameSamples; i++) {
        const s = samples[start + i];
        sumSq += s * s;
        if ((s >= 0 && prev < 0) || (s < 0 && prev >= 0)) zc++;
        prev = s;
      }
      const rms = Math.sqrt(sumSq / frameSamples) / 32768;
      const zcr = zc / (frameSamples - 1);
      rmsList[f] = rms;
      zcrList[f] = zcr;
    }

    // Noise-Floor grob
    const sortedRms = rmsList.slice().sort((a, b) => a - b);
    const p = (arr, q) => arr[Math.max(0, Math.min(arr.length - 1, Math.floor((arr.length - 1) * q)))];
    const noise = Math.max(1e-6, p(sortedRms, 0.2));

    const voicedMask = rmsList.map((r, i) => (r > noise * 2 && zcrList[i] < 0.25) ? 1 : 0);

    const frameDur = frameSamples / rate; // sek/Frame = 0.02 s
    const maxVoiceFrames = Math.floor(maxVoiceSeconds / frameDur);

    // kumulativ "voiced"-Frames zählen bis Limit erreicht ist → dort abschneiden (+ kleinen Puffer)
    let cumVoiced = 0;
    let cutFrame = totalFrames - 1;
    for (let f = 0; f < totalFrames; f++) {
      if (voicedMask[f]) cumVoiced++;
      if (cumVoiced >= maxVoiceFrames) { cutFrame = f; break; }
    }

    // Wenn sowieso unterhalb des Limits → nichts croppen
    if (cumVoiced < maxVoiceFrames) return null;

    // Sekunden berechnen + Pads
    const leadFrames = Math.floor(padLeadSec / frameDur);
    const tailFrames = Math.floor(padTailSec / frameDur);
    const endFrameIncl = Math.min(totalFrames - 1, cutFrame + tailFrames);
    // Start lassen wir bei 0 (wir wollen nicht mitten im Satz beginnen); wer will, könnte hier zum
    // letzten Unvoiced vor der ersten Voice springen und dann padLeadSec addieren.

    const seconds = (endFrameIncl + 1) * frameDur + 0; // ab 0 bis inkl. endFrame
    return Math.max(0.5, seconds); // nie < 0.5s
  } catch {
    return null;
  }
}



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
      summaryPrompt: json.summaryPrompt || json.summary_prompt || "",
      admins: Array.isArray(json.admins) ? json.admins : []      // ← NEU
    };
  } catch {
    return {
      persona: "", instructions: "", voice: "", name: "", botname: "",
      selectedTools: [], blocks: [], summaryPrompt: "", admins: [] // ← NEU
    };
  }
}


// ---------- Channel-Config ----------

function getChannelConfig(channelId) {
  const configPath = path.join(__dirname, "channel-config", `${channelId}.json`);
  const def = getDefaultPersona();

  // Defaults (robust, inkl. Fallbacks)
  let persona       = def.persona || "";
  let instructions  = def.instructions || "";
  let voice         = def.voice || "";
  let name          = def.name || "";
  let botname       = def.botname || "AI";
  let selectedTools = def.selectedTools || def.tools || [];
  let blocks        = Array.isArray(def.blocks) ? def.blocks : [];
  let summaryPrompt = def.summaryPrompt || def.summary_prompt || "";
  let max_user_messages = (Number.isFinite(Number(def.max_user_messages)) && Number(def.max_user_messages) >= 0)
    ? Number(def.max_user_messages)
    : null;
  let admins        = Array.isArray(def.admins) ? def.admins.map(String) : [];

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

      // max_user_messages: snake_case oder camelCase, Zahl oder numerischer String
      const rawMax = (cfg.max_user_messages ?? cfg.maxUserMessages);
      if (rawMax === null || rawMax === undefined || rawMax === "") {
        max_user_messages = null; // AUS
      } else {
        const n = Number(rawMax);
        max_user_messages = (Number.isFinite(n) && n >= 0) ? Math.floor(n) : null;
      }

      // Admins sauber übernehmen
      if (Array.isArray(cfg.admins)) admins = cfg.admins.map(String);

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
    max_user_messages,       // ← WICHTIG: an bot.js durchreichen
    hasConfig: hasConfigFile,
    summariesEnabled,
    admins
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

// Nach sendChunked(...)
async function postSummariesIndividually(channel, summaries, headerPrefix = null) {
  for (let i = 0; i < summaries.length; i++) {
    const header =
      headerPrefix
        ? `${headerPrefix} ${i + 1}/${summaries.length}`
        : `**Summary ${i + 1}/${summaries.length}**`;
    await sendChunked(channel, `${header}\n\n${summaries[i]}`);
  }
}


// discord-helper.js
async function setMessageReaction(message, emoji) {
  const STATUS = ["⏳", "✅", "❌"];
  try {
    const me = message.client?.user;
    if (!me) return;

    // Alle bisherigen Status-Reaktionen des BOTS entfernen
    const toRemove = message.reactions?.cache?.filter(r => STATUS.includes(r.emoji?.name)) || [];
    for (const r of toRemove.values()) {
      try {
        // Nur unsere eigene Reaktion entfernen – dafür braucht der Bot keine ManageMessages
        await r.users.remove(me.id);
      } catch {}
    }

    // Neue gewünschte Reaktion setzen (falls angegeben)
    if (emoji && STATUS.includes(emoji)) {
      await message.react(emoji).catch(() => {});
    }
  } catch (e) {
    console.warn("[setMessageReaction] failed:", e?.message || e);
  }
}


// ---------- Webhook Reply ----------
// ---------- Webhook Reply (Avatar = aus Persona generiert) ----------
async function setReplyAsWebhook(message, content, { botname /* avatarUrl ignorieren */ }) {
  try {
    // Falls Thread: Webhook immer am Parent erstellen
    const isThread = typeof message.channel.isThread === "function" ? message.channel.isThread() : false;
    const hookChannel = isThread ? message.channel.parent : message.channel;

    // ChannelMeta laden (Parent wenn Thread)
    const effectiveChannelId = isThread ? (message.channel.parentId || message.channel.id) : message.channel.id;
    const meta = getChannelConfig(effectiveChannelId);

    // Avatar sicherstellen (nur Persona)
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
    // Fallback ohne Webhook
    await sendChunked(message.channel, content);
  }
}


// ---------- Transcripts-Thread ----------


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


async function setAddUserMessage(message, chatContext) {
  try {
    const raw = (message?.content || "").trim();
    // Keine Commands ins Log schreiben
    if (raw.startsWith("!")) return;

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



// temp-Datei anlegen
async function makeTmpFile(ext = ".wav") {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dgpt-"));
  const file = path.join(dir, `${Date.now()}${ext}`);
  return { dir, file };
}

// PCM → WAV (über ffmpeg aus einem Readable-Stream)
function writePcmToWav(pcmReadable, { rate = 48000, channels = 1 } = {}) {
  return new Promise(async (resolve, reject) => {
    try {
      const { dir, file } = await makeTmpFile(".wav");
      ffmpeg()
        .input(pcmReadable)
        .inputOptions([`-f s16le`, `-ar ${rate}`, `-ac ${channels}`]) // Roh-PCM-Format
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

// Discord-ID → Anzeigename
async function resolveSpeakerName(client, guildId, userId) {
  try {
    const g = await client.guilds.fetch(guildId);
    const m = await g.members.fetch(userId).catch(() => null);
    return m?.displayName || m?.user?.username || "Unknown";
  } catch {
    return "Unknown";
  }
}



// --- Quick SNR + Voicing Gate für 48kHz/mono WAV ---
async function quickSNR(wavPath) {
  const buf = await fs.promises.readFile(wavPath);

  // sehr einfache RIFF/WAV-Parsing-Logik: "data"-Chunk finden
  function findDataChunk(b) {
    // RIFF Header: 12 bytes, dann Chunks
    let p = 12;
    while (p + 8 <= b.length) {
      const id = b.toString('ascii', p, p + 4);
      const size = b.readUInt32LE(p + 4);
      if (id === 'data') return { offset: p + 8, size };
      p += 8 + size;
    }
    return null;
  }

  const data = findDataChunk(buf);
  if (!data || data.size < 960 * 2) { // < 20ms
    return { snrDb: 0, voicedRatio: 0, frames: 0 };
  }

  // PCM16 mono
  const pcm = new Int16Array(
    buf.buffer,
    buf.byteOffset + data.offset,
    data.size / 2
  );

  const frameSize = 960; // 20ms @ 48kHz
  const energies = [];
  const zcrs = [];

  for (let i = 0; i + frameSize <= pcm.length; i += frameSize) {
    let e = 0;
    let z = 0;
    let prev = pcm[i];
    for (let j = i; j < i + frameSize; j++) {
      const s = pcm[j] / 32768; // normiert [-1..1]
      e += s * s;
      const cur = pcm[j];
      if ((cur >= 0 && prev < 0) || (cur < 0 && prev >= 0)) z++;
      prev = cur;
    }
    e /= frameSize;                         // mittlere Energie
    const zcr = z / frameSize;              // Zero-Crossing-Rate
    energies.push(e);
    zcrs.push(zcr);
  }

  if (energies.length < 3) {
    return { snrDb: 0, voicedRatio: 0, frames: energies.length };
  }

  const sorted = [...energies].sort((a, b) => a - b);
  const idx20 = Math.max(0, Math.floor(sorted.length * 0.20) - 1);
  const idx80 = Math.max(0, Math.floor(sorted.length * 0.80) - 1);
  const noise = Math.max(sorted[idx20], 1e-9);
  const signal = Math.max(sorted[idx80], noise + 1e-9);
  const snrDb = 10 * Math.log10(signal / noise);

  // voiced-Frames: Energie deutlich über Noise + ZCR im Sprachbereich (nicht zu flach)
  const energyThresh = noise * 3.0;
  let voiced = 0;
  for (let k = 0; k < energies.length; k++) {
    if (energies[k] > energyThresh && zcrs[k] < 0.25) voiced++;
  }
  const voicedRatio = voiced / energies.length;

  return { snrDb, voicedRatio, frames: energies.length };
}


// In discord-helper.js
// discord-helper.js
async function setStartListening(connection, guildId, guildTextChannels, client, onTranscript /* <= NEU */) {
  try {
    if (!connection || !guildId) return;

    if (!setStartListening.__capturingUsers) setStartListening.__capturingUsers = new Set();
    if (!setStartListening.__lastUtteranceMap) setStartListening.__lastUtteranceMap = new Map();
    const capturingUsers   = setStartListening.__capturingUsers;   // Set<`${guildId}:${userId}`>
    const lastUtteranceMap = setStartListening.__lastUtteranceMap; // Map<key, {norm, ts}>

    const DUP_WINDOW_MS      = 5000;
    const SILENCE_MS         = 2100;
    const MAX_UTTERANCE_MS   = 30000;
    const MIN_WAV_BYTES      = 96000; // ~1s @ 48k/16bit/mono

    const MIN_SNR_DB         = 8;
    const MIN_VOICED_RATIO   = 0.40;
    const MIN_VOICED_FRAMES  = 15;

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

        const sr = 48000, frame = 960;
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

    const receiver = connection.receiver;
    if (!receiver) return;

    receiver.speaking.removeAllListeners("start");
    receiver.speaking.on("start", (userId) => {
      const key = `${guildId}:${userId}`;
      if (capturingUsers.has(key)) return;
      capturingUsers.add(key);

      const startedAtMs = Date.now(); // <<<<< WICHTIG: Start-Timestamp

      let killTimer = null;
      try {
        const opus = receiver.subscribe(userId, {
          end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
        });

        const pcm  = opus.pipe(new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 }));
        const pass = new PassThrough();
        const wavPromise = writePcmToWav(pass, { rate: 48000, channels: 1 });

        pcm.on("data", (chunk) => pass.write(chunk));

        killTimer = setTimeout(() => { try { opus.destroy(); } catch {} }, MAX_UTTERANCE_MS);

        const finish = async () => {
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
            if (snrDb < MIN_SNR_DB || voicedRatio < MIN_VOICED_RATIO || voicedFrames < MIN_VOICED_FRAMES) {
              return;
            }

            const text  = await getTranscription(file, "whisper-1", "auto");
            const clean = (text || "").trim();
            if (!clean) return;

            const norm = normText(clean);
            const now  = Date.now();
            const last = lastUtteranceMap.get(key);
            if (last && last.norm === norm && (now - last.ts) < DUP_WINDOW_MS) return;
            lastUtteranceMap.set(key, { norm, ts: now });

            const speaker = await resolveSpeakerName(client, guildId, userId);

            // <<<<< NEU: NICHT posten – per Callback an bot.js liefern
            if (typeof onTranscript === "function") {
              await onTranscript({
                guildId,
                channelId: latestTarget.id,
                userId,
                speaker,
                text: clean,
                startedAtMs: startedAtMs
              });
            }
          } catch (err) {
            console.warn("[Transcription] failed:", err?.message || err);
          } finally {
            try {
              const { dir } = await wavPromise;
              await fs.promises.rm(dir, { recursive: true, force: true });
            } catch {}
            capturingUsers.delete(key);
          }
        };

        pcm.once("end", finish);
        pcm.once("error", (e) => {
          console.warn("[PCM stream error]:", e?.message || e);
          try { pass.destroy(); } catch {}
          if (killTimer) { clearTimeout(killTimer); killTimer = null; }
          capturingUsers.delete(key);
        });

      } catch (e) {
        console.warn("[Voice subscribe] failed:", e?.message || e);
        if (killTimer) { clearTimeout(killTimer); killTimer = null; }
        capturingUsers.delete(key);
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




async function getSpeech(connection, guildId, text, client, voice) {
  if (!connection || !text?.trim()) return;
  const chunks = getSplitTextToChunks(text);

  setEnqueueTTS(guildId, async () => {
    let player = playerMap.get(guildId);
    if (!player) {
      const { createAudioPlayer } = require("@discordjs/voice");
      player = createAudioPlayer();
      // Optionales Sicherheitsnetz gegen Warnungen bei sehr vielen Chunks
      if (typeof player.setMaxListeners === "function") player.setMaxListeners(50);
      playerMap.set(guildId, player);
    }

    // Nach Channel-Wechsel immer (re)subscriben
    try { connection.subscribe(player); } catch {}

    const { AudioPlayerStatus } = require("@discordjs/voice");

    for (const chunk of chunks) {
      try {
        const response = await getTTS(chunk, "tts-1", voice);
        const pass = new PassThrough();
        response.pipe(pass);

        const decoder = new prism.FFmpeg({
          args: ["-i", "pipe:0", "-f", "s16le", "-ar", "48000", "-ac", "2"]
        });
        const pcmStream = pass.pipe(decoder);
        const resource = createAudioResource(pcmStream, { inputType: StreamType.Raw });

        // Listener erst registrieren, dann play() aufrufen – und beim Abschluss wieder entfernen
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

        // kleiner Puffer zwischen Chunks
        await new Promise((r) => setTimeout(r, 100));
      } catch (e) {
        console.error("[TTS ERROR]:", e);
      }
    }
  });
}



async function getOrCreateRelayWebhookFor(parentChannel) {
  try {
    if (!parentChannel) return null;
    const key = parentChannel.id;
    if (transcriptWebhookCache.has(key)) return transcriptWebhookCache.get(key);

    // Webhook am PARENT-Textkanal anlegen oder wiederverwenden
    const hooks = await parentChannel.fetchWebhooks();
    let hook = hooks.find(w => w.name === "Transcripts Relay");
    if (!hook) {
      hook = await parentChannel.createWebhook({
        name: "Transcripts Relay",
      });
    }
    transcriptWebhookCache.set(key, hook);
    return hook;
  } catch (e) {
    console.error("[Transcripts Relay] webhook create/fetch failed:", e?.message || e);
    return null;
  }
}

async function sendTranscriptViaWebhook(targetChannelOrThread, content, username, avatarURL) {
  try {
    if (!targetChannelOrThread || !content?.trim()) return;

    // Threads besitzen keine eigenen Webhooks -> am Parent-Kanal anlegen, aber mit threadId senden
    const isThread = !!targetChannelOrThread?.isThread?.();
    const parent = isThread ? targetChannelOrThread.parent : targetChannelOrThread;
    const hook = await getOrCreateRelayWebhookFor(parent);
    if (!hook) {
      // Fallback ohne Webhook
      return await sendChunked(targetChannelOrThread, `**${username}:** ${content}`);
    }

    const parts = splitIntoChunks(content);
    for (const p of parts) {
      await hook.send({
        content: p,
        username: username || "Speaker",
        avatarURL: avatarURL || undefined,
        allowedMentions: { parse: [] },
        threadId: isThread ? targetChannelOrThread.id : undefined,
      });
    }
  } catch (e) {
    console.error("[Transcripts Relay] send failed:", e?.message || e);
    // Fallback
    try { await sendChunked(targetChannelOrThread, `**${username}:** ${content}`); } catch {}
  }
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
  getOrCreateRelayWebhookFor,
  setStartListening,
  getSpeech,
  resetTTSPlayer,
  resetRecordingFlag, 
  postSummariesIndividually,
  sendTranscriptViaWebhook,

};

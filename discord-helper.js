// discord-helper.js — v1.8
// Voice (TTS + optional Transcripts-Thread), Chunking, Webhook-Replies, Channel-Config (inkl. summaryPrompt)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { tools, getToolRegistry } = require("./tools.js");
const { EndBehaviorType, createAudioResource, StreamType } = require("@discordjs/voice");
const { PassThrough } = require("stream");
const prism = require("prism-media");
const ffmpeg = require("fluent-ffmpeg");
const axios = require("axios");
const { getAIImage, getTranscription, getTTS } = require("./aiService.js");
require("dotenv").config();

ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH || "/usr/bin/ffmpeg");

const activeRecordings = new Map();
const _avatarInFlight = new Map(); // ⬅️ verhindert parallele Generierungen
const transcriptWebhookCache = new Map(); // key: parentChannelId -> webhook


// --- Persona → Visual-Prompt (per GPT) ---
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

      // ↓↓↓ NEU
      if (Array.isArray(cfg.admins)) def.admins = cfg.admins;
    } catch (e) {
      console.error(`[ERROR] Failed to parse channel config ${channelId}:`, e.message);
    }
  }

  const { registry: toolRegistry, tools: ctxTools } = getToolRegistry(selectedTools);

  const avatarPath = path.join(__dirname, "documents", "avatars", `${channelId}.png`);
  const avatarUrl = fs.existsSync(avatarPath)
    ? `https://ralfreschke.de/documents/avatars/${channelId}.png`
    : `https://ralfreschke.de/documents/avatars/default.png`;

  // NEW: Flag, ob es eine echte Channel-Datei gab
  const hasConfigFile = fs.existsSync(configPath);
  // NEW: Summaries nur erlauben, wenn es eine Channel-Datei gibt UND ein Prompt gesetzt ist
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
    hasConfig: hasConfigFile,
    summariesEnabled,
    admins: def.admins || []                
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

async function setMessageReaction(message, emoji) {
  try { 
    await message.react(emoji);
  } catch (e) {
    console.warn("[setMessageReaction] failed:", e?.message || e);
  }
}

async function postSummariesIndividually(channel, summaries, _leftover) {
  for (let i = 0; i < summaries.length; i++) {
    const header = `**Summary ${i + 1}/${summaries.length}**`;
    await sendChunked(channel, `${header}\n\n${summaries[i]}`);
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


async function getOrCreateRelayWebhookFor(parentChannel) {
  try {
    if (!parentChannel) return null;
    const cacheKey = parentChannel.id; // ⬅️ renamed
    if (transcriptWebhookCache.has(cacheKey)) return transcriptWebhookCache.get(cacheKey);

    const hooks = await parentChannel.fetchWebhooks();
    let hook = hooks.find(w => w.name === "Transcripts Relay");
    if (!hook) {
      hook = await parentChannel.createWebhook({ name: "Transcripts Relay" });
    }
    transcriptWebhookCache.set(cacheKey, hook); // ⬅️ renamed
    return hook;
  } catch (e) {
    console.error("[Transcripts Relay] webhook create/fetch failed:", e?.message || e);
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


async function setStartListening(connection, guildId, guildTextChannels, client) {
  try {
    if (!connection || !guildId) return;
    if (activeRecordings.get(guildId)) return; // schon aktiv

    const textChannelId = guildTextChannels.get(guildId);
    const textChannel = textChannelId ? await client.channels.fetch(textChannelId).catch(() => null) : null;
    if (!textChannel) return;

    const target = textChannel; // ⬅️ direkt in den Kanal posten, kein Thread

    const receiver = connection.receiver;
    if (!receiver) return;

    activeRecordings.set(guildId, true);

    receiver.speaking.on("start", (userId) => {
      try {
        // 1) Opus abonnieren
        const opus = receiver.subscribe(userId, {
          end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 } // 1s Stille = Ende
        });

        // 2) Opus → PCM
        const pcm = opus.pipe(new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 }));

        // 3) PCM in PassThrough schieben, ffmpeg gleichzeitig starten
        const pass = new PassThrough();
        const wavPromise = writePcmToWav(pass, { rate: 48000, channels: 1 });

        let bytes = 0;
        pcm.on("data", (chunk) => {
          bytes += chunk.length;
          pass.write(chunk);
        });
        pcm.on("end", async () => {
          pass.end();
          try {
            const { dir, file } = await wavPromise;

            // sehr kurze Aufnahmen überspringen (z.B. < 0.5s bei 48kHz mono 16-bit ~ 48kB)
            const st = await fs.promises.stat(file).catch(() => null);
            if (!st || st.size < 48000) {
              try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch {}
              return;
            }

            // 4) Transkribieren —> WICHTIG: Dateipfad übergeben
            // Wenn deine aiService.getTranscription einen Stream erwartet:
            //   const text = await getTranscription(fs.createReadStream(file), "whisper-1", "auto");
            // Wenn sie einen Dateipfad erwartet (häufiger Fall):
            const text = await getTranscription(file, "whisper-1", "auto");

            if (text && text.trim()) {
              const speaker = await resolveSpeakerName(client, guildId, userId);
              let avatarURL;
              try {
                const g = await client.guilds.fetch(guildId);
                const m = await g.members.fetch(userId).catch(() => null);
                avatarURL = m?.user?.displayAvatarURL?.({ extension: "png", size: 256 });
              } catch {}
              await sendTranscriptViaWebhook(target, text.trim(), speaker, avatarURL);
            }
          } catch (err) {
            console.warn("[Transcription] failed:", err?.message || err);
          } finally {
            // 5) Aufräumen
            try {
              const { dir } = await wavPromise; // dir aus dem Promise ziehen
              await fs.promises.rm(dir, { recursive: true, force: true });
            } catch {}
          }
        });

        pcm.on("error", (e) => {
          console.warn("[PCM stream error]:", e?.message || e);
          try { pass.destroy(); } catch {}
        });
      } catch (e) {
        console.warn("[Voice subscribe] failed:", e?.message || e);
      }
    });

    // Aufräumen, wenn Verbindung endet
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
      player.setMaxListeners(50);
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
  postSummariesIndividually,
  getOrCreateRelayWebhookFor,
  setStartListening,
  getSpeech,
  sendTranscriptViaWebhook,

};

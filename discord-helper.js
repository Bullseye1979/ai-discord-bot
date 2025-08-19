// discord-helper.js
// Version 3.1
// - Voice-Transkription (Whisper) -> als Webhook-Nachricht im Textkanal posten (username = Sprecher)
// - Diese Webhook-Nachrichten werden wie normale User-Messages vom Bot verarbeitet und landen dadurch im Chat-Kontext
// - TTS-Ausgabe für AI-Antworten im Voice-Channel
// - Channel-Config-Auflösung inkl. Block-Overrides (user/speaker) und Tools-Registry
// - Utility-Funktionen (Reaktionen, Präsenz, Chat leeren, etc.)

require('dotenv').config();

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  EndBehaviorType,
  getVoiceConnection,
} = require('@discordjs/voice');

const prism = require('prism-media');
const { getTranscription, getTTS } = require('./aiService.js');
const { getToolRegistry } = require('./tools.js');
const { getSafeDelete } = require('./helper.js');

// -------- Globale Caches --------
/** Merkt pro Textkanal eine (oder mehrere) Webhooks zur Sprach-Weiterleitung */
const channelWebhookCache = new Map(); // channelId -> webhook

/** Audio-Player pro Guild (eine Instanz reicht idR) */
const guildAudioPlayers = new Map();   // guildId -> AudioPlayer

// ===== Utilitys =====

async function setBotPresence(client, text = '✅ Ready', status = 'online') {
  try {
    await client.user.setPresence({
      activities: [{ name: text }],
      status,
    });
  } catch {}
}

async function setMessageReaction(message, emoji) {
  try {
    await message.react(emoji);
  } catch {}
}

/**
 * Löscht "sichtbar" den Textkanal (max. die letzten ~1000 Nachrichten paginiert),
 * ohne Garantien, je nach Berechtigungen.
 */
async function setEmptyChat(channel) {
  try {
    let lastId = null;
    for (let i = 0; i < 10; i++) {
      const msgs = await channel.messages.fetch({ limit: 100, before: lastId || undefined });
      if (msgs.size === 0) break;
      const deletable = [...msgs.values()].filter(m => m.deletable);
      for (const m of deletable) {
        try { await m.delete(); } catch {}
      }
      lastId = msgs.last().id;
      if (msgs.size < 100) break;
    }
  } catch (err) {
    console.warn('[setEmptyChat] Warn:', err.message);
  }
}

async function setReplyAsWebhook(message, text, { botname = 'AI', avatarUrl = null } = {}) {
  try {
    const hooks = await message.channel.fetchWebhooks();
    let hook = hooks.find(h => h.name === botname);

    if (!hook) {
      hook = await message.channel.createWebhook({
        name: botname,
        avatar: avatarUrl || undefined,
        reason: 'AI reply webhook',
      });
    }

    await hook.send({
      content: text,
      username: botname,
      avatarURL: avatarUrl || undefined,
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    // Fallback: normal senden
    try { await message.channel.send(text); } catch {}
  }
}

/**
 * Fügt eine eingehende Textnachricht in den Chat-Kontext.
 * Erwartet: chatContext (Context-Instanz), message (Discord.js Message)
 */
async function setAddUserMessage(message, chatContext) {
  try {
    // Prefer DisplayName, fallback auf Username
    const display =
      message.member?.displayName ||
      message.author?.username ||
      'user';

    // Text-Inhalt; bei Anhängen (z. B. Bilder) füge die URLs an
    let content = message.content || '';
    if (message.attachments?.size) {
      const links = [...message.attachments.values()].map(a => a.url).join('\n');
      content = content ? `${content}\n${links}` : links;
    }

    if (!content || !content.trim()) return;
    await chatContext.add('user', display, content.trim());
  } catch (err) {
    console.warn('[setAddUserMessage] Warn:', err.message);
  }
}

// ===== Channel-Config =====

/**
 * Lädt die Channel-Config aus ./channel-config/<channelId>.json und
 * wendet optional Block-Overrides (userId / speaker) an.
 *
 * Rückgabe:
 * - null, wenn keine Config
 * - Objekt mit: botname, voice, name, model, apikey, persona, instructions,
 *               tools, toolRegistry, avatarUrl, blocks (unverändert)
 */
function getChannelConfig(channelId, opts = null) {
  try {
    const cfgPath = path.join(__dirname, 'channel-config', `${channelId}.json`);
    if (!fs.existsSync(cfgPath)) return null;

    const raw = fs.readFileSync(cfgPath, 'utf8');
    const cfg = JSON.parse(raw);

    // Basiswerte
    const base = {
      botname: cfg.botname || 'AI',
      voice: cfg.voice || 'alloy',
      name: (cfg.name || cfg.botname || 'bot').toLowerCase(),
      model: cfg.model || 'gpt-4o',
      apikey: cfg.apikey || null,
      persona: cfg.persona || '',
      instructions: cfg.instructions || '',
      tools: [],
      toolRegistry: {},
      avatarUrl: cfg.avatarUrl || null,
      blocks: Array.isArray(cfg.blocks) ? cfg.blocks : [],
    };

    // Tool-Setup (Channel-weit)
    if (Array.isArray(cfg.tools) && cfg.tools.length > 0) {
      const { tools, registry } = getToolRegistry(cfg.tools);
      base.tools = tools;
      base.toolRegistry = registry;
    }

    // Ohne Auflösung zurückgeben (Existenzprüfung u. ä.)
    if (!opts) return base;

    const { userId, speaker } = opts;

    // Passender Block (ODER-Logik: userId || speaker)
    const match = base.blocks.find(b => {
      const okUser = Array.isArray(b.user) && b.user.map(String).includes(String(userId || ''));
      const okSpeaker = Array.isArray(b.speaker) && b.speaker.includes(String(speaker || ''));
      return okUser || okSpeaker;
    });

    if (!match) return base;

    // Overrides anwenden
    const out = { ...base };
    if (match.model) out.model = match.model;
    if (match.apikey) out.apikey = match.apikey;
    if (Array.isArray(match.tools) && match.tools.length > 0) {
      const { tools, registry } = getToolRegistry(match.tools);
      out.tools = tools;
      out.toolRegistry = registry;
    }
    if (typeof match.voice === 'string') out.voice = match.voice;
    if (typeof match.botname === 'string') out.botname = match.botname;
    if (typeof match.name === 'string') out.name = match.name;

    return out;
  } catch (err) {
    console.warn('[getChannelConfig] Warn:', err.message);
    return null;
  }
}

// ===== TTS-Ausgabe =====

/**
 * Spricht Text im Voice-Channel der Guild (falls Bot verbunden).
 * - Verwendet OpenAI TTS (getTTS), responseType: 'stream'
 */
async function getSpeech(connection, guildId, text, client, voice = 'alloy') {
  try {
    if (!connection) return;
    let player = guildAudioPlayers.get(guildId);
    if (!player) {
      player = createAudioPlayer();
      guildAudioPlayers.set(guildId, player);
      connection.subscribe(player);
    }

    const ttsStream = await getTTS(text, 'tts-1', voice);
    const resource = createAudioResource(ttsStream);
    player.play(resource);

    // Optional: warten bis fertig (nicht zwingend)
    await new Promise((resolve) => {
      const onIdle = () => {
        player.off(AudioPlayerStatus.Idle, onIdle);
        resolve();
      };
      player.on(AudioPlayerStatus.Idle, onIdle);
    });
  } catch (err) {
    console.warn('[getSpeech] Warn:', err.message);
  }
}

// ===== Sprachaufzeichnung & Transkription =====

/**
 * Erzeugt (oder cached) einen Kanal-WebHook für "Voice Relay".
 */
async function getOrCreateRelayWebhook(textChannel) {
  const cached = channelWebhookCache.get(textChannel.id);
  if (cached) return cached;
  const hooks = await textChannel.fetchWebhooks();
  let hook = hooks.find(h => h.name === 'Voice Relay');
  if (!hook) {
    hook = await textChannel.createWebhook({
      name: 'Voice Relay',
      reason: 'Post transcriptions as user-like messages',
    });
  }
  channelWebhookCache.set(textChannel.id, hook);
  return hook;
}

/**
 * Konvertiert rohe PCM-Buffer in eine einfache WAV-Datei (PCM 16 LE, 48kHz, mono).
 */
function writeWavFile(filePath, pcmBuffer) {
  const numChannels = 1;
  const sampleRate = 48000;
  const bitsPerSample = 16;

  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);                            // ChunkID
  header.writeUInt32LE(36 + dataSize, 4);             // ChunkSize
  header.write('WAVE', 8);                            // Format
  header.write('fmt ', 12);                           // Subchunk1ID
  header.writeUInt32LE(16, 16);                       // Subchunk1Size (16 for PCM)
  header.writeUInt16LE(1, 20);                        // AudioFormat (1 = PCM)
  header.writeUInt16LE(numChannels, 22);              // NumChannels
  header.writeUInt32LE(sampleRate, 24);               // SampleRate
  header.writeUInt32LE(byteRate, 28);                 // ByteRate
  header.writeUInt16LE(blockAlign, 32);               // BlockAlign
  header.writeUInt16LE(bitsPerSample, 34);            // BitsPerSample
  header.write('data', 36);                           // Subchunk2ID
  header.writeUInt32LE(dataSize, 40);                 // Subchunk2Size

  const fileBuffer = Buffer.concat([header, pcmBuffer]);
  fs.writeFileSync(filePath, fileBuffer);
}

/**
 * (Optional) sehr einfacher VAD / Plausibilitätscheck.
 * Standard: 48 kHz, Mindestlänge ~1.0 s, leichte SNR/Volume-Schwellen.
 */
function getIsSpeechDetected(filePath, sampleRate = 48000) {
  try {
    const pcmData = fs.readFileSync(filePath);
    const frameSize = sampleRate / 10; // 100ms
    const minLengthSeconds = 1.0;      // vorher 2.5 (zu streng)
    const durationSeconds = pcmData.length / (sampleRate * 2);
    if (durationSeconds < minLengthSeconds) return false;

    // sehr simple Heuristik
    let voicedFrames = 0;
    const totalFrames = Math.floor(pcmData.length / (frameSize * 2));
    for (let i = 0; i < pcmData.length; i += frameSize * 2) {
      const chunk = pcmData.slice(i, i + frameSize * 2);
      let sum = 0;
      for (let j = 0; j < chunk.length; j += 2) {
        const s = chunk.readInt16LE(j);
        sum += Math.abs(s);
      }
      const avg = sum / (chunk.length / 2);
      if (avg > 400) voicedFrames++; // grobe Lautstärkeleitplanke
    }
    return voicedFrames > Math.max(3, totalFrames * 0.15);
  } catch {
    return true; // im Zweifel transkribieren
  }
}

/**
 * Startet die Voice-Aufnahme & Transkription.
 * - connection: VoiceConnection
 * - guildId: Guild-ID
 * - guildTextChannels: Map(guildId -> textChannelId) (kommt aus bot.js)
 * - activeRecordings: Map (wird hier nicht tief genutzt, aber kompatibel)
 * - client: Discord.Client
 *
 * Ablauf:
 *   1) abonnieren wir alle Sprecher (connection.receiver)
 *   2) für jeden Sprach-Chunk -> decode nach PCM, baue WAV, an Whisper -> Text
 *   3) sende den Text als Webhook-Nachricht (username = Sprechername, avatar = Useravatar)
 *      => Bot-Handler sieht das als "Webhook-Speaker" und legt es in den passenden Kontext.
 */
async function setStartListening(connection, guildId, guildTextChannels, activeRecordings, client) {
  if (!connection) return;
  const receiver = connection.receiver;

  // Der Textkanal, in den wir posten sollen
  const textChannelId = guildTextChannels.get(guildId);
  if (!textChannelId) return;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;
  const textChannel = guild.channels.cache.get(textChannelId);
  if (!textChannel || !textChannel.isTextBased()) return;

  const hook = await getOrCreateRelayWebhook(textChannel);

  receiver.speaking.on('start', async (userId) => {
    try {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) return;

      // Opus -> PCM
      const opusStream = receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: 1200, // 1.2s Stille => Ende
        },
      });

      const decoder = new prism.opus.Decoder({
        frameSize: 960,
        channels: 1,
        rate: 48000,
      });

      const pcmChunks = [];
      opusStream.pipe(decoder);

      decoder.on('data', (chunk) => {
        pcmChunks.push(chunk);
      });

      decoder.on('end', async () => {
        try {
          if (!pcmChunks.length) return;

          const pcmBuffer = Buffer.concat(pcmChunks);
          // sehr kurze/kleine Aufnahme ignorieren (~ < 0.3s)
          if (pcmBuffer.length < 48000 * 2 * 0.3) return;

          // WAV schreiben
          const tmpDir = path.join(__dirname, 'tmp');
          await fsp.mkdir(tmpDir, { recursive: true });
          const wavPath = path.join(tmpDir, `rec_${guildId}_${userId}_${Date.now()}.wav`);
          writeWavFile(wavPath, pcmBuffer);

          // einfacher VAD / Reject sehr kurzer Stille
          if (!getIsSpeechDetected(wavPath, 48000)) {
            await getSafeDelete(wavPath);
            return;
          }

          // an Whisper
          const text = await getTranscription(wavPath); // nutzt whisper-1
          await getSafeDelete(wavPath);

          if (!text || !text.trim() || text.startsWith('[ERROR]')) return;

          // Als Webhook posten => username = Sprechername, avatar = User-Avatar
          const display = member.displayName || member.user.username || 'user';
          const avatar = member.user.displayAvatarURL?.() || null;

          await hook.send({
            content: text.trim(),
            username: display,           // << wichtig: pro Nachricht Sprechername setzen
            avatarURL: avatar || undefined,
            allowedMentions: { parse: [] },
          });

          // Optional: auch kurz visuelles Feedback in den Chat
          // await textChannel.send(`🎤 **${display}**: ${text.trim()}`);

        } catch (errEnd) {
          console.warn('[voice] end-handler warn:', errEnd.message);
        }
      });

      decoder.on('error', (e) => {
        console.warn('[voice] decoder error:', e.message);
      });
    } catch (err) {
      console.warn('[voice] start-handler warn:', err.message);
    }
  });
}

// ===== Exports =====
module.exports = {
  // vom Bot/Handler erwartete Exporte:
  setEmptyChat,
  setBotPresence,
  setMessageReaction,
  setAddUserMessage,
  getChannelConfig,
  setReplyAsWebhook,
  getSpeech,

  // Voice
  setStartListening,
};

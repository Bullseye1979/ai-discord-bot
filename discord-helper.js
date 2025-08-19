//Version 2.0
//Offers functions that are used to make handling with Discord easier
// ✨ NEU:
// - Keine Verwendung von globalem default.json mehr für fehlende Channels
// - Channel-Config unterstützt blocks[], default_user, default_speaker
// - Auflösung einer passenden Block-Konfiguration pro Nachricht (userId / speaker)
// - Export: getChannelMeta(channelId) & resolveChannelConfig(channelId, { userId, speaker })

const fs = require("fs");
const path = require("path");
const { tools, getToolRegistry } = require('./tools.js');
const { EndBehaviorType } = require("@discordjs/voice");
const { createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } = require("@discordjs/voice");
const { PassThrough } = require('stream');
const prism = require("prism-media");
const { getSafeDelete } = require("./helper.js");
const { getTranscription, getTTS } = require("./aiService.js");
require("dotenv").config();
const ffmpeg = require("fluent-ffmpeg");
ffmpeg.setFfmpegPath("/usr/bin/ffmpeg");

// Variables
const queueMap = new Map();
const playerMap = new Map();

// ---------- Hilfsfunktionen für Channel-Config ----------

function getChannelConfigPath(channelId) {
    return path.join(__dirname, "channel-config", `${channelId}.json`);
}

/**
 * Lädt die rohe Channel-Config-Datei (ohne Fallback!).
 * @returns {object|null}
 */
function loadRawChannelConfig(channelId) {
    const cfgPath = getChannelConfigPath(channelId);
    if (!fs.existsSync(cfgPath)) return null;
    try {
        const raw = fs.readFileSync(cfgPath, "utf8");
        const cfg = JSON.parse(raw);

        // Sanity defaults (nur Top-Level, KEIN globaler default.json Fallback)
        return {
            name: cfg.name || "bot",
            botname: cfg.botname || "AI",
            persona: cfg.persona || "",
            instructions: cfg.instructions || "",
            voice: cfg.voice || "alloy",
            // Tools pro Block; Top-Level tools ignorieren wir zugunsten der Blocks
            blocks: Array.isArray(cfg.blocks) ? cfg.blocks : [],
            default_user: cfg.default_user || null,
            default_speaker: cfg.default_speaker || null
        };
    } catch (err) {
        console.error(`[ERROR] Failed to parse channel-config for ${channelId}:`, err.message);
        return null;
    }
}

/**
 * Liefert Meta-Daten des Channels (Name, Botname, Voice, Avatar-URL).
 * Gibt null zurück, wenn es KEINE Channel-Config gibt.
 */
function getChannelMeta(channelId) {
    const cfg = loadRawChannelConfig(channelId);
    if (!cfg) return null;

    const avatarPath = path.join(__dirname, "documents", "avatars", `${channelId}.png`);
    const avatarUrl = fs.existsSync(avatarPath)
        ? `https://ralfreschke.de/documents/avatars/${channelId}.png`
        : `https://ralfreschke.de/documents/avatars/default.png`;

    return {
        name: cfg.name,
        botname: cfg.botname,
        voice: cfg.voice,
        persona: cfg.persona,
        instructions: cfg.instructions,
        avatarUrl
    };
}

/**
 * Ermittelt den passenden Block für eine Nachricht.
 * Regeln:
 * 1) Exakte Übereinstimmung userId -> erster Block mit user enthält userId.
 * 2) Sonst: exakte Übereinstimmung speaker (Webhook-Name) -> erster Block mit speaker enthält den Namen.
 * 3) Falls Webhook-Nachricht: default_speaker (wenn vorhanden), sonst KEINE Reaktion.
 * 4) Falls User-Nachricht: default_user (wenn vorhanden), sonst KEINE Reaktion.
 *
 * Rückgabe: null wenn NICHT reagieren; sonst ein Objekt mit
 *   { persona, instructions, botname, voice, avatarUrl, tools, toolRegistry, model, apikey, matchedBy }
 */
function resolveChannelConfig(channelId, { userId = null, speaker = null } = {}) {
    const base = getChannelMeta(channelId);
    if (!base) return null; // ❌ Keine Channel-Config -> keine Reaktion

    const raw = loadRawChannelConfig(channelId); // vorhanden, da base != null
    const blocks = raw.blocks || [];

    const findBlockByUser = () => {
        if (!userId) return null;
        return blocks.find(b => Array.isArray(b.user) && b.user.includes(String(userId))) || null;
    };
    const findBlockBySpeaker = () => {
        if (!speaker) return null;
        return blocks.find(b => Array.isArray(b.speaker) && b.speaker.includes(String(speaker))) || null;
    };

    let matched = findBlockByUser();
    let matchedBy = null;
    if (matched) matchedBy = "user";
    if (!matched) {
        matched = findBlockBySpeaker();
        if (matched) matchedBy = "speaker";
    }

    // Default-Logik getrennt nach User und Speaker
    if (!matched) {
        if (speaker) {
            // Webhook-Nachricht
            if (raw.default_speaker) {
                matched = raw.default_speaker;
                matchedBy = "default_speaker";
            } else {
                return null; // ❌ Nicht erwähnter Sprecher -> NICHT reagieren
            }
        } else {
            // User-Nachricht
            if (raw.default_user) {
                matched = raw.default_user;
                matchedBy = "default_user";
            } else {
                return null; // ❌ Kein default_user -> NICHT reagieren
            }
        }
    }

    const toolNames = Array.isArray(matched.tools) ? matched.tools : [];
    const { tools: filteredTools, registry: toolRegistry } = getToolRegistry(toolNames);

    return {
        ...base,
        tools: filteredTools,
        toolRegistry,
        model: matched.model || "gpt-4o-mini",
        apikey: matched.apikey || null,
        matchedBy
    };
}

// ---------- Vorhandene Utility-Funktionen (unverändert, aber an Meta-Funktion angepasst) ----------

async function setReplyAsWebhook(message, content, config = {}) {
    try {
        const botname = config.botname || "AI";
        const avatarUrl = config.avatarUrl || message.client.user.displayAvatarURL();
        const webhooks = await message.channel.fetchWebhooks();
        let webhook = webhooks.find(w => w.name === botname);
        if (!webhook) {
            webhook = await message.channel.createWebhook({ name: botname });
        }
        const parts = content.match(/[\s\S]{1,2000}/g) || [];
        for (const part of parts) {
            await webhook.send({
                content: part,
                username: botname,
                avatarURL: avatarUrl
            });
        }
    } catch (err) {
        console.error("[ERROR] Failed to send via webhook:", err);
    }
}

async function setBotPresence(client, activityText, status, activityType = 4) {
    if (client && client.user) {
        await client.user.setPresence({
            activities: [{ name: activityText, type: activityType }],
            status: status
        });
    }
}

async function setMessageReaction(message, emoji) {
    try {
        await message.reactions.removeAll();
        await message.react(emoji);
    } catch (err) {
        console.warn("[WARN]: Could not modify reactions:", err);
    }
}

async function setAddUserMessage(message, chatContext) {
    let content = message.content;
    if (message.attachments?.size > 0) {
        const attachmentLinks = message.attachments.map(a => a.url).join("\n");
        content = `${attachmentLinks}\n${content}`;
    }
    const senderName = message.member?.displayName
        || message.author?.username
        || "user";

    await chatContext.add("user", senderName, content);
}

async function setEmptyChat(channel) {
    try {
        let skippedCount = 0;
        let hasMore = true;
        while (hasMore) {
            const fetched = await channel.messages.fetch({ limit: 100 });
            hasMore = fetched.size > 0;
            for (const msg of fetched.values()) {
                if (msg.pinned) { skippedCount++; continue; }
                try {
                    await msg.delete();
                    await new Promise(res => setTimeout(res, 150));
                } catch {
                    skippedCount++;
                }
            }
        }
        if (skippedCount > 0) {
            console.warn(`[WARN]: Could not delete all files (${skippedCount} remaining).`);
        }
    } catch (err) {
        console.error("[ERROR]", err);
    }
}

async function setStartListening(connection, guildId, guildTextChannels, activeRecordings, client) {
    const receiver = connection.receiver;
    receiver.speaking.on("start", async (userId) => {
        if (activeRecordings.has(userId)) return;
        const textChannelId = guildTextChannels.get(guildId);
        const textChannel = client.channels.cache.get(textChannelId);
        if (!textChannel) return;
        activeRecordings.set(userId, true);
        await setTranscribeAudio(receiver, userId, textChannel, activeRecordings, client);
    });
}

async function setTranscribeAudio(receiver, userId, textChannel, activeRecordings, client) {
    const timestamp = Date.now();
    const rawAudio = `audio_${userId}_${timestamp}.pcm`;
    const wavAudio = `audio_${userId}_${timestamp}.wav`;
    const opusStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 2000 },
    });
    const pcmStream = new prism.opus.Decoder({ frameSize: 960, channels: 1, rate: 48000 });
    const fileStream = fs.createWriteStream(rawAudio);
    opusStream.pipe(pcmStream).pipe(fileStream);

    opusStream.on("close", async () => {
        activeRecordings.delete(userId);
        try {
            await setConvertAudio(rawAudio, wavAudio);
            if (!getIsSpeechDetected(rawAudio)) {
                return;
            }
            const transcript = await getTranscription(wavAudio);
            if (transcript && transcript.trim()) {
                let username = `User-${userId}`;
                let avatarURL = null;
                try {
                    const member = await textChannel.guild.members.fetch(userId);
                    if (member) {
                        username = member.displayName || member.user.username || username;
                        avatarURL = member.user.displayAvatarURL();
                    }
                } catch { /* ignore */ }

                try {
                    const webhooks = await textChannel.fetchWebhooks();
                    let webhook = webhooks.find(wh => wh.name === "VoiceTranscriber");
                    if (!webhook) {
                        webhook = await textChannel.createWebhook({
                            name: "VoiceTranscriber",
                            avatar: client.user.displayAvatarURL(),
                        });
                    }
                    await webhook.send({
                        content: transcript,
                        username,
                        avatarURL: avatarURL || undefined,
                    });
                } catch (err) {
                    console.error("[ERROR]: ", err);
                    await textChannel.send(`**${username}**: ${transcript}`);
                }
            }
        } catch (err) {
            console.error(`[ERROR]: `, err);
        }
        await getSafeDelete(rawAudio);
        await getSafeDelete(wavAudio);
    });
}

function setConvertAudio(input, output) {
    return new Promise((resolve, reject) => {
        ffmpeg(input)
            .inputFormat("s16le")
            .audioFrequency(48000)
            .audioChannels(1)
            .audioCodec("pcm_s16le")
            .toFormat("wav")
            .on("end", () => resolve())
            .on("error", (err) => reject(err))
            .save(output);
    });
}

function getIsSpeechDetected(filePath, sampleRate = 16000) {
    const pcmData = fs.readFileSync(filePath);
    const frameSize = sampleRate / 10; // 100ms
    const minLengthSeconds = 2.5;

    const durationSeconds = pcmData.length / (sampleRate * 2);
    if (durationSeconds < minLengthSeconds) return false;

    let speechDetected = false;
    for (let i = 0; i < pcmData.length; i += frameSize * 2) {
        const chunk = pcmData.slice(i, i + frameSize * 2);
        const avgVolume = getAverageVolume(chunk);
        const snr = getSNR(chunk);
        if (avgVolume > 0.02 && snr > 5) { speechDetected = true; break; }
    }
    return speechDetected;
}

function getAverageVolume(chunk) {
    let sum = 0;
    for (let i = 0; i < chunk.length; i += 2) {
        let sample = chunk.readInt16LE(i) / 32768;
        sum += Math.abs(sample);
    }
    return sum / (chunk.length / 2);
}

function getSNR(chunk) {
    let signalPower = 0;
    let noisePower = 0;
    const threshold = 0.005;
    for (let i = 0; i < chunk.length; i += 2) {
        let sample = chunk.readInt16LE(i) / 32768;
        if (Math.abs(sample) > threshold) signalPower += sample * sample;
        else noisePower += sample * sample;
    }
    if (noisePower === 0) return 100;
    return 10 * Math.log10(signalPower / noisePower);
}

function setEnqueueTTS(guildId, task) {
    if (!queueMap.has(guildId)) queueMap.set(guildId, []);
    const queue = queueMap.get(guildId);
    queue.push(task);
    if (queue.length === 1) setProcessTTSQueue(guildId);
}

async function setProcessTTSQueue(guildId) {
    const queue = queueMap.get(guildId);
    if (!queue || queue.length === 0) return;
    const task = queue[0];
    try { await task(); } catch (err) { console.error("[ERROR]:", err); }
    finally {
        queue.shift();
        if (queue.length > 0) setProcessTTSQueue(guildId);
    }
}

function getSplitTextToChunks(text, maxChars = 500) {
    const sentences = text.match(/[^.!?\n]+[.!?\n]?/g) || [text];
    const chunks = [];
    let current = "";
    for (const sentence of sentences) {
        if ((current + sentence).length > maxChars) {
            chunks.push(current.trim());
            current = sentence;
        } else {
            current += sentence;
        }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
}

async function getSpeech(connection, guildId, text, client, voice) {
    if (!connection || !text || !text.trim()) return;
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
                const passThrough = new PassThrough();
                response.pipe(passThrough);
                const decoder = new prism.FFmpeg({ args: ['-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2'] });
                const pcmStream = passThrough.pipe(decoder);
                const resource = createAudioResource(pcmStream, { inputType: StreamType.Raw });
                player.play(resource);
                await new Promise((resolve, reject) => {
                    player.once(AudioPlayerStatus.Idle, resolve);
                    player.once('error', reject);
                });
                await new Promise(res => setTimeout(res, 100));
            } catch (error) {
                console.error('[ERROR]:', error);
            }
        }
    });
}

// Exports
module.exports = {
    // neue Exporte
    getChannelMeta,
    resolveChannelConfig,
    // bestehende Exporte
    setStartListening,
    getSpeech,
    setReplyAsWebhook,
    setEmptyChat,
    setBotPresence,
    setMessageReaction,
    setAddUserMessage
};

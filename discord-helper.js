//Version 1.0
//Offers functions that are used to make handling with Discord easier

const fs = require("fs");
const path = require("path");
const { tools, getToolRegistry } = require('./tools.js');
const { WebhookClient } = require('discord.js');
const { EndBehaviorType } = require("@discordjs/voice");
const { createAudioPlayer, createAudioResource, joinVoiceChannel, AudioPlayerStatus, StreamType } = require("@discordjs/voice");
const { PassThrough } = require('stream');
const axios = require("axios");
const ffmpeg = require("fluent-ffmpeg");
const prism = require("prism-media");
const { getSafeDelete } = require("./helper.js");
const { getTranscription, getTTS } = require("./aiService.js");
require("dotenv").config();
ffmpeg.setFfmpegPath("/usr/bin/ffmpeg");


// Variables

const queueMap = new Map();
const playerMap = new Map(); 


// Functions


// Resolve user Tools

function getUserTools(nameOrDisplayName) {
    const configPath = path.join(__dirname, "permissions.json");
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);

    const defaultTools = parsed.default?.tools || [];
    const userTools = parsed.users?.[nameOrDisplayName]?.tools;

    const toolNames = Array.isArray(userTools) ? userTools : defaultTools;
    const activeTools = tools.filter(t => toolNames.includes(t.function.name));
    const { registry: toolRegistry } = getToolRegistry(toolNames);

    return {
        tools: activeTools,
        toolRegistry
    };
}


// Default Persona laden 

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
            selectedTools: json.tools || []

        };
    } catch (err) {
        console.warn("[WARN] Could not load default persona/instructions:", err.message);
        return { persona: "", instructions: "", voice: "", name: "", botname: "", selectedTools: "" };
    }
}


// Answer via webhook

async function setReplyAsWebhook(message, content, config = {}) {
    try {
        const botname = config.botname || "AI";
        const avatarUrl = config.avatarUrl || message.client.user.displayAvatarURL();
        const webhooks = await message.channel.fetchWebhooks();
        let webhook = webhooks.find(w => w.name === botname);
        if (!webhook) {
            webhook = await message.channel.createWebhook({
                name: botname
            });
        }
        const MAX_LENGTH = 2000;
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


// Get channel based bot configuration

function getChannelConfig(channelId) {
    const configPath = path.join(__dirname, "channel-config", `${channelId}.json`);
    const defaultConfig = getDefaultPersona();
    let { persona, instructions, voice, name, botname, selectedTools } = defaultConfig;
    if (fs.existsSync(configPath)) {
        try {
            const rawData = fs.readFileSync(configPath, "utf8");
            const config = JSON.parse(rawData);

            if (typeof config.voice === "string") voice = config.voice;
            if (typeof config.botname === "string") botname = config.botname;
            if (typeof config.name === "string") name = config.name;
            if (typeof config.persona === "string") persona = config.persona;
            if (typeof config.instructions === "string") instructions = config.instructions;
            if (Array.isArray(config.tools)) {
                selectedTools = tools.filter(t => config.tools.includes(t.function.name));
            }
        } catch (err) {
            console.error(`[ERROR] Failed to load channel config for ${channelId}:`, err.message);
        }
    }

    const { registry: toolRegistry, tools } = getToolRegistry(selectedTools);

    const avatarPath = path.join(__dirname, "documents", "avatars", `${channelId}.png`);
    const avatarUrl = fs.existsSync(avatarPath)
        ? `https://ralfreschke.de/documents/avatars/${channelId}.png`
        : `https://ralfreschke.de/documents/avatars/default.png`;;

    return {
        name,
        botname,
        voice,
        persona,
        avatarUrl,
        instructions,
        tools,
        toolRegistry
    };
}




// Set the status that the bot presents

async function setBotPresence(client, activityText, status, activityType = 4) {
    if (client && client.user) {
        await client.user.setPresence({
            activities: [{ name: activityText, type: activityType }],
            status: status
        });
    }
}


// React to the message

async function setMessageReaction(message, emoji) {
    try {
        await message.reactions.removeAll();
        await message.react(emoji);
    } catch (err) {
        console.warn("[WARN]: Could not modify reactions:", err);
    }
}


// Add the user message to the context. This is needed, as this function considers attachments.

async function setAddUserMessage(message, chatContext) {
    let content = message.content;
    if (message.attachments.size > 0) {
        const attachmentLinks = message.attachments.map(a => a.url).join("\n");
        content = `${attachmentLinks}\n${content}`;
    }
    const senderName = message.member?.displayName
        || message.author?.username
        || "user";

    await chatContext.add("user", senderName, content);
}


// Remove all messages from the chat

async function setEmptyChat(channel) {
    try {
        let deletedCount = 0;
        let skippedCount = 0;
        let hasMore = true;
        while (hasMore) {
            const fetched = await channel.messages.fetch({ limit: 100 });
            hasMore = fetched.size > 0;
            for (const msg of fetched.values()) {
                if (msg.pinned) {
                    skippedCount++;
                    continue;
                }
                try {
                    await msg.delete();
                    deletedCount++;
                    await new Promise(res => setTimeout(res, 150)); // Rate limit friendly
                } catch (err) {
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


// Start the listener

async function setStartListening(connection, guildId, guildTextChannels, activeRecordings, client) {
    const receiver = connection.receiver;
    receiver.speaking.on("start", async (userId) => {
        if (activeRecordings.has(userId)) return;
       const textChannelId = guildTextChannels.get(guildId);
        const textChannel = client.channels.cache.get(textChannelId);
        if (!textChannel) return;
        activeRecordings.set(userId, true);
        await setTranscribeAudio(receiver, userId, textChannel, activeRecordings,client);
    });
}


// Record the Audio and transcribe it

async function setTranscribeAudio(receiver, userId, textChannel, activeRecordings,client) {
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
                let user = { username: `User-${userId}`, displayAvatarURL: () => null };

                try {
                    const webhooks = await textChannel.fetchWebhooks();
                    let webhook = webhooks.find(wh => wh.name === "VoiceTranscriber");
                    if (!webhook) {
                        webhook = await textChannel.createWebhook({
                            name: "VoiceTranscriber",
                            avatar: client.user.displayAvatarURL(),
                        });
                    }

                    try {
                        const member = await textChannel.guild.members.fetch(userId);
                        if (member) {
                            user = {
                                username: member.displayName || member.user.username || user.username,
                                displayAvatarURL: () => member.user.displayAvatarURL(),
                            };
                        }
                    } catch (err) {
                        console.warn("[WARN]: ", err);
                    }

                    await webhook.send({
                        content: transcript,
                        username: user.username,
                        avatarURL: user.displayAvatarURL(),
                    });

                } catch (err) {
                    console.error("[ERROR]: ", err);
                    await textChannel.send(`**${user.username}**: ${transcript}`);
                }
            }
        } catch (err) {
            console.error(`[ERROR]: `, err);
        }
        await getSafeDelete(rawAudio);
        await getSafeDelete(wavAudio);
    });
}


// Convert Audio in a format that whisper can work with

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


// Check wheter speech is contained in the file

function getIsSpeechDetected(filePath, sampleRate = 16000) {
    const pcmData = fs.readFileSync(filePath);
    const frameSize = sampleRate / 10; // 100ms
    const minLengthSeconds = 2.5;
    const minFrames = (sampleRate * minLengthSeconds) / frameSize;

    const durationSeconds = pcmData.length / (sampleRate * 2);
    if (durationSeconds < minLengthSeconds) {
        return false;
    }

    let speechDetected = false;

    for (let i = 0; i < pcmData.length; i += frameSize * 2) {
        const chunk = pcmData.slice(i, i + frameSize * 2);
        const avgVolume = getAverageVolume(chunk);
        const snr = getSNR(chunk);

        if (avgVolume > 0.02 && snr > 5) {
            speechDetected = true;
            break;
        }
    }

    return speechDetected;
}


// Get the average volume of the audio

function getAverageVolume(chunk) {
    let sum = 0;
    for (let i = 0; i < chunk.length; i += 2) {
        let sample = chunk.readInt16LE(i) / 32768;
        sum += Math.abs(sample);
    }
    return sum / (chunk.length / 2);
}


// Check the SNR of the Audio

function getSNR(chunk) {
    let signalPower = 0;
    let noisePower = 0;
    const threshold = 0.005;

    for (let i = 0; i < chunk.length; i += 2) {
        let sample = chunk.readInt16LE(i) / 32768;
        if (Math.abs(sample) > threshold) {
            signalPower += sample * sample;
        } else {
            noisePower += sample * sample;
        }
    }

    if (noisePower === 0) return 100;
    return 10 * Math.log10(signalPower / noisePower);
}


// Put texts in the voice queue

function setEnqueueTTS(guildId, task) {
    if (!queueMap.has(guildId)) {
        queueMap.set(guildId, []);
    }
    const queue = queueMap.get(guildId);
    queue.push(task);
    if (queue.length === 1) {
        setProcessTTSQueue(guildId);
    }
}


// Process the voice queue

async function setProcessTTSQueue(guildId) {
    const queue = queueMap.get(guildId);
    if (!queue || queue.length === 0) return;
    const task = queue[0];
    try {
        await task();
    } catch (err) {
        console.error("[ERROR]:", err);
    } finally {
        queue.shift();
        if (queue.length > 0) {
            setProcessTTSQueue(guildId);
        }
    }
}


// Split the text into chunks to avoid errors with long texts

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


// Read the text that is displayed in Discord in voice chat

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
                const response = await getTTS(chunk,"tts-1",voice);
                const passThrough = new PassThrough();
                response.pipe(passThrough);
                const decoder = new prism.FFmpeg({
                    args: [
                        '-i', 'pipe:0',
                        '-f', 's16le',
                        '-ar', '48000',
                        '-ac', '2',
                    ],
                });
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

module.exports = {  getUserTools, getDefaultPersona, setStartListening,getSpeech, setReplyAsWebhook, getChannelConfig, setEmptyChat, setBotPresence, setMessageReaction, setAddUserMessage };
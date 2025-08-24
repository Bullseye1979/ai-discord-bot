// Version 1.1 (mit DEBUG-Logs)
// Provides basic AI services to use for the tools

require('dotenv').config();
const axios = require('axios');
const { OPENAI_API_URL } = require('./config.js');
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");

// Send a request to GPT (einfacher Helper)
async function getAI(context, tokenlimit = 4096, model = "gpt-4-turbo") {
    const payload = {
        model: model,
        messages: [...context.messages],
        max_tokens: tokenlimit
    };

    // 🔎 DEBUG: Minimalvorschau
    try {
        console.log("──────────────── DEBUG:getAI → OpenAI Payload ───────────────────────");
        console.log(JSON.stringify({
            model,
            max_tokens: tokenlimit,
            messages_preview: payload.messages.map(m => ({
                role: m.role,
                name: m.name,
                content: (m.content || "").slice(0, 400)
            }))
        }, null, 2));
        console.log("──────────────────────────────────────────────────────────────────────");
    } catch { /* ignore */ }

    const aiResponse = await axios.post(OPENAI_API_URL, payload, {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
    });

    try {
        const meta = {
            created: aiResponse.data?.created,
            model: aiResponse.data?.model,
            finish_reason: aiResponse.data?.choices?.[0]?.finish_reason
        };
        console.log("DEBUG:getAI ← OpenAI Meta:", meta);
    } catch { /* ignore */ }

    const aiMessage = aiResponse.data.choices[0].message;
    return aiMessage.content || "";
}

// Send a request to DALL-E
async function getAIImage(prompt, size = "1024x1024", model="dall-e-3") {
    const dallEResponse = await axios.post(
        "https://api.openai.com/v1/images/generations",
        {
            model: model,
            prompt: prompt,
            n: 1,
            size: size
        },
        {
            headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                "Content-Type": "application/json"
            }
        }
    );
    const imageUrl = dallEResponse?.data?.data?.[0]?.url;
    if (!imageUrl) {
        throw new Error("Kein Bild erhalten.");
    }
    return imageUrl;
}

// Send a soundfile to Whisper
async function getTranscription(audioPath, model="whisper-1") {
    try {
        const fileStream = fs.createReadStream(audioPath);
        const filename = path.basename(audioPath);
        const formData = new FormData();
        formData.append("file", fileStream, { filename, contentType: "audio/wav" });
        formData.append("model", model);
        const response = await axios.post("https://api.openai.com/v1/audio/transcriptions", formData, {
            headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                ...formData.getHeaders(),
            },
        });
        return response.data.text;
    } catch (error) {
        console.error("[ERROR]: ", error.response?.data || error.message);
        return "[ERROR]: Error during transcription.";
    }
}

// Generate an TTS audio stream
async function getTTS(text,model="tts-1",voice) {
    const response = await axios.post(
        'https://api.openai.com/v1/audio/speech',
        {
            model: model,
            voice: voice,
            input: text,
            response_format: 'mp3'
        },
        {
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            responseType: 'stream'
        }
    );
    return response.data;
}

// Get an image description
async function getDescription(imageUrl, prompt = "Describe the image in as much detail as possible. Extract text, if there is any.", model="gpt-4o") {
    try {
        const response = await axios.post(
            OPENAI_API_URL,
            {
                model: model,
                messages: [
                    {
                        role: "system",
                        content: "You are an AI assistant that analyzes and describes images."
                    },
                    {
                        role: "user",
                        content: [
                            { type: "text", text: prompt },
                            { type: "image_url", image_url: { url: imageUrl } }
                        ]
                    }
                ],
                max_tokens: 500
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
                }
            }
        );
        return response.data.choices[0]?.message?.content?.trim() || "No description available.";
    } catch (error) {
        console.error("[ERROR]:", error.response?.data || error.message);
        return "[ERROR]: Error analyzing the image.";
    }
}

module.exports = { getAI, getAIImage, getTranscription, getTTS, getDescription };

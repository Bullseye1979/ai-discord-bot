// aiService.js — Version 1.2 (DEBUG minimal, keine Änderung an Tools / APIs)
require('dotenv').config();
const axios = require('axios');
const { OPENAI_API_URL } = require('./config.js');
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");

// Sichere Fehlerausgabe (Authorization-Header maskiert)
function logAxiosErrorSafe(prefix, err) {
  const msg = err?.message || String(err);
  console.error(prefix, msg);
  if (err.response) {
    try {
      const safeHeaders = { ...err.response.headers };
      if (safeHeaders.authorization) safeHeaders.authorization = "Bearer ***";
      const safeConfig = { ...err.response.config };
      if (safeConfig?.headers?.Authorization) {
        safeConfig.headers = { ...safeConfig.headers, Authorization: "Bearer ***" };
      }
      console.error(`${prefix} Response:`, {
        status: err.response.status,
        statusText: err.response.statusText,
        headers: safeHeaders,
        data: err.response.data,
        config: {
          method: safeConfig.method,
          url: safeConfig.url
        }
      });
    } catch (e) {
      console.error(`${prefix} (while masking)`, e);
    }
  }
}

// Einfacher GPT-Call (ohne Tools)
async function getAI(context, tokenlimit = 4096, model = "gpt-4o") {
  const payload = {
    model: model,
    messages: [...context.messages],
    max_tokens: tokenlimit
  };

  // DEBUG: Minimalvorschau
  try {
    console.log("──────────────── DEBUG:getAI → OpenAI Payload ───────────────────────");
    console.log(JSON.stringify({
      model,
      max_tokens: tokenlimit,
      messages_preview: payload.messages.map(m => ({
        role: m.role,
        name: m.name,
        content: (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 400)
      }))
    }, null, 2));
    console.log("──────────────────────────────────────────────────────────────────────");
  } catch { /* ignore */ }

  try {
    const aiResponse = await axios.post(OPENAI_API_URL, payload, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" }
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
  } catch (err) {
    logAxiosErrorSafe("[ERROR]: getAI failed:", err);
    throw err;
  }
}

// DALL·E (Generationen)
async function getAIImage(prompt, size = "1024x1024", model="dall-e-3") {
  try {
    const dallEResponse = await axios.post(
      "https://api.openai.com/v1/images/generations",
      { model, prompt, n: 1, size },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );
    const imageUrl = dallEResponse?.data?.data?.[0]?.url;
    if (!imageUrl) throw new Error("Kein Bild erhalten.");
    return imageUrl;
  } catch (err) {
    logAxiosErrorSafe("[ERROR]: getAIImage failed:", err);
    throw err;
  }
}

// Whisper (Transkription)
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
    logAxiosErrorSafe("[ERROR]: transcription failed:", error);
    return "[ERROR]: Error during transcription.";
  }
}

// TTS
async function getTTS(text, model="tts-1", voice) {
  const response = await axios.post(
    'https://api.openai.com/v1/audio/speech',
    { model, voice, input: text, response_format: 'mp3' },
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

// Bildbeschreibung (Vision)
async function getDescription(imageUrl, prompt = "Describe the image in as much detail as possible. Extract text, if there is any.", model="gpt-4o") {
  try {
    const response = await axios.post(
      OPENAI_API_URL,
      {
        model,
        messages: [
          { role: "system", content: "You are an AI assistant that analyzes and describes images." },
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
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
    );
    return response.data.choices[0]?.message?.content?.trim() || "No description available.";
  } catch (error) {
    logAxiosErrorSafe("[ERROR]: vision description failed:", error);
    return "[ERROR]: Error analyzing the image.";
  }
}

module.exports = { getAI, getAIImage, getTranscription, getTTS, getDescription };

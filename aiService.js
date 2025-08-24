// aiService.js — v1.2 (robust + debug)
// Provides basic AI services to use for the tools

require('dotenv').config();
const axios = require('axios');
const { OPENAI_API_URL } = require('./config.js');
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");

// Small helper for safe previews in logs
function previewMessages(messages, limit = 3, maxLen = 140) {
  try {
    const sliced = (messages || []).slice(0, limit).map((m) => ({
      role: m.role,
      // name nur zeigen, wenn vorhanden
      ...(m.name ? { name: m.name } : {}),
      // content kürzen für Log
      content: (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, maxLen)
    }));
    return JSON.stringify(sliced, null, 2);
  } catch {
    return "[[unavailable]]";
  }
}

// --- Chat Completion (generic) ---
async function getAI(context, tokenlimit = 4096, model = "gpt-4o") {
  // ✅ Fallback: niemals leeres messages-Array senden
  const safeMessages = Array.isArray(context?.messages) ? [...context.messages] : [];

  if (safeMessages.length === 0) {
    safeMessages.push({
      role: "system",
      content: "You are a helpful assistant. Answer briefly and clearly."
    });
  }

  const payload = {
    model,
    messages: safeMessages,
    max_tokens: tokenlimit
  };

  // 🔎 Debug-Ausgabe
  try {
    console.log("──────── DEBUG:getAI → OpenAI Payload ────────");
    console.log(JSON.stringify({
      model,
      max_tokens: tokenlimit,
      messages_preview: JSON.parse(previewMessages(safeMessages))
    }, null, 2));
    console.log("──────────────────────────────────────────────");
  } catch {
    // ignore logging errors
  }

  try {
    const aiResponse = await axios.post(OPENAI_API_URL, payload, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
    });

    const choice = aiResponse?.data?.choices?.[0];
    const content = choice?.message?.content || "";

    // 🔎 Meta-Log
    console.log("DEBUG:getAI ← OpenAI Meta:", {
      created: aiResponse?.data?.created,
      model: aiResponse?.data?.model,
      finish_reason: choice?.finish_reason
    });

    return content;
  } catch (err) {
    // Ausführliche Fehlerdiagnose
    console.error("[AI ERROR]:", err?.message || err);
    if (err?.response) {
      console.error("[AI ERROR] Response:", {
        status: err.response.status,
        statusText: err.response.statusText,
        headers: err.response.headers,
        data: err.response.data
      });
    }
    // Wir werfen weiter, damit der Caller (z.B. aiCore / Tool) korrekt reagieren kann
    throw err;
  }
}

// --- Image Generation (DALL·E 3 endpoint) ---
async function getAIImage(prompt, size = "1024x1024", model = "dall-e-3") {
  // 🔎 Debug
  console.log("──────── DEBUG:getAIImage → Request ──────────");
  console.log(JSON.stringify({ model, size, prompt_preview: String(prompt || "").slice(0, 200) }, null, 2));
  console.log("──────────────────────────────────────────────");

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
    if (!imageUrl) {
      throw new Error("Kein Bild erhalten.");
    }

    // 🔎 Meta-Log
    console.log("DEBUG:getAIImage ← OpenAI Meta:", {
      created: dallEResponse?.data?.created,
      model: dallEResponse?.data?.model || model
    });

    return imageUrl;
  } catch (error) {
    console.error("[ERROR:getAIImage]:", error?.message || error);
    if (error?.response) {
      console.error("[ERROR:getAIImage] Response:", {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      });
    }
    throw error;
  }
}

// --- Whisper Transcription ---
async function getTranscription(audioPath, model = "whisper-1") {
  try {
    const fileStream = fs.createReadStream(audioPath);
    const filename = path.basename(audioPath);
    const formData = new FormData();
    formData.append("file", fileStream, { filename, contentType: "audio/wav" });
    formData.append("model", model);

    console.log("DEBUG:getTranscription →", { model, filename });

    const response = await axios.post("https://api.openai.com/v1/audio/transcriptions", formData, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        ...formData.getHeaders(),
      },
    });
    return response.data.text;
  } catch (error) {
    console.error("[ERROR:getTranscription]: ", error.response?.data || error.message);
    return "[ERROR]: Error during transcription.";
  }
}

// --- TTS (text → speech) ---
async function getTTS(text, model = "tts-1", voice) {
  console.log("DEBUG:getTTS →", { model, voice, text_preview: String(text || "").slice(0, 120) });

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
  return response.data; // Stream
}

// --- Vision: describe image ---
async function getDescription(imageUrl, prompt = "Describe the image in as much detail as possible. Extract text, if there is any.", model = "gpt-4o") {
  try {
    console.log("DEBUG:getDescription →", { model, imageUrl_preview: String(imageUrl || "").slice(0, 160) });

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
      {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
      }
    );
    const out = response.data.choices[0]?.message?.content?.trim() || "No description available.";
    console.log("DEBUG:getDescription ← OpenAI Meta:", {
      created: response?.data?.created,
      model: response?.data?.model
    });
    return out;
  } catch (error) {
    console.error("[ERROR:getDescription]:", error.response?.data || error.message);
    return "[ERROR]: Error analyzing the image.";
  }
}

module.exports = {
  getAI,
  getAIImage,
  getTranscription,
  getTTS,
  getDescription
};

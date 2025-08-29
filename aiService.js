// aiService.js — clean v1.3
// Core AI helpers: chat, image gen, transcription, TTS, and vision.

require("dotenv").config();
const axios = require("axios");
const { OPENAI_API_URL } = require("./config.js");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");

/** Build a short preview of messages for logs. */
function previewMessages(messages, limit = 3, maxLen = 140) {
  try {
    const sliced = (messages || []).slice(0, limit).map((m) => ({
      role: m.role,
      ...(m.name ? { name: m.name } : {}),
      content:
        (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, maxLen),
    }));
    return JSON.stringify(sliced, null, 2);
  } catch {
    return "[[unavailable]]";
  }
}

/** Normalize axios error into a safe, compact object. */
function toSafeAxiosError(err, tag = "AI_ERROR") {
  const status = err?.response?.status;
  const statusText = err?.response?.statusText;
  const data = err?.response?.data;
  const requestId =
    err?.response?.headers?.["x-request-id"] ||
    err?.response?.headers?.["X-Request-ID"] ||
    null;

  return {
    tag,
    message: err?.message || String(err),
    status: status ?? null,
    statusText: statusText ?? null,
    requestId,
    data: typeof data === "string" ? data.slice(0, 2000) : data,
  };
}

/** Chat completion; returns assistant text or throws structured error. */
async function getAI(context, tokenlimit = 4096, model = "gpt-4o") {
  const safeMessages = Array.isArray(context?.messages) ? [...context.messages] : [];
  if (safeMessages.length === 0) {
    safeMessages.push({ role: "system", content: "You are a helpful assistant. Be concise." });
  }

  const payload = { model, messages: safeMessages, max_tokens: tokenlimit };

  try {
    console.log("getAI → payload (preview)", {
      model,
      max_tokens: tokenlimit,
      messages_preview: JSON.parse(previewMessages(safeMessages)),
    });
  } catch {}

  try {
    const aiResponse = await axios.post(OPENAI_API_URL, payload, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      timeout: 60000,
    });
    const choice = aiResponse?.data?.choices?.[0];
    const content = choice?.message?.content || "";
    console.log("getAI ← meta", {
      created: aiResponse?.data?.created,
      model: aiResponse?.data?.model,
      finish_reason: choice?.finish_reason,
    });
    return content;
  } catch (err) {
    const safe = toSafeAxiosError(err, "CHAT_ERROR");
    console.error(safe);
    throw new Error(JSON.stringify(safe));
  }
}

/** Image generation; returns a hosted image URL or throws structured error. */
async function getAIImage(prompt, size = "1024x1024", model = "dall-e-3") {
  try {
    console.log("getAIImage →", {
      model,
      size,
      prompt_preview: String(prompt || "").slice(0, 200),
    });

    const res = await axios.post(
      "https://api.openai.com/v1/images/generations",
      { model, prompt, n: 1, size },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 60000,
      }
    );

    const imageUrl = res?.data?.data?.[0]?.url;
    if (!imageUrl) {
      throw new Error(JSON.stringify({ tag: "IMAGE_ERROR", message: "No image URL returned." }));
    }

    console.log("getAIImage ← meta", {
      created: res?.data?.created,
      model: res?.data?.model || model,
    });

    return imageUrl;
  } catch (err) {
    const safe = toSafeAxiosError(err, "IMAGE_ERROR");
    console.error(safe);
    throw new Error(JSON.stringify(safe));
  }
}

/** Speech-to-text (Whisper); returns text or an '[ERROR] …' string with details. */
async function getTranscription(audioPath, model = "whisper-1") {
  try {
    const fileStream = fs.createReadStream(audioPath);
    const filename = path.basename(audioPath);
    const formData = new FormData();
    formData.append("file", fileStream, { filename, contentType: "audio/wav" });
    formData.append("model", model);

    console.log("getTranscription →", { model, filename });

    const response = await axios.post(
      "https://api.openai.com/v1/audio/transcriptions",
      formData,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          ...formData.getHeaders(),
        },
        timeout: 120000,
      }
    );
    return response.data.text;
  } catch (err) {
    const safe = toSafeAxiosError(err, "TRANSCRIPTION_ERROR");
    console.error(safe);
    return `[ERROR]: ${safe.tag} (${safe.status} ${safe.statusText}) — ${safe.message}${
      safe.requestId ? ` — requestId=${safe.requestId}` : ""
    }`;
  }
}

/** Text-to-speech; returns a readable stream or throws structured error. */
async function getTTS(text, model = "tts-1", voice) {
  try {
    console.log("getTTS →", { model, voice, text_preview: String(text || "").slice(0, 120) });
    const response = await axios.post(
      "https://api.openai.com/v1/audio/speech",
      { model, voice, input: text, response_format: "mp3" },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        responseType: "stream",
        timeout: 120000,
      }
    );
    return response.data;
  } catch (err) {
    const safe = toSafeAxiosError(err, "TTS_ERROR");
    console.error(safe);
    throw new Error(JSON.stringify(safe));
  }
}

/** Vision description from image URL; returns text or an '[ERROR] …' string. */
async function getDescription(
  imageUrl,
  prompt = "Describe the image in detail. Extract any visible text.",
  model = "gpt-4o"
) {
  try {
    console.log("getDescription →", {
      model,
      imageUrl_preview: String(imageUrl || "").slice(0, 160),
    });

    const response = await axios.post(
      OPENAI_API_URL,
      {
        model,
        messages: [
          { role: "system", content: "You analyze and describe images precisely." },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
        max_tokens: 500,
      },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, timeout: 60000 }
    );

    const out = response.data.choices[0]?.message?.content?.trim() || "No description available.";
    console.log("getDescription ← meta", {
      created: response?.data?.created,
      model: response?.data?.model,
    });
    return out;
  } catch (err) {
    const safe = toSafeAxiosError(err, "VISION_ERROR");
    console.error(safe);
    return `[ERROR]: ${safe.tag} (${safe.status} ${safe.statusText}) — ${safe.message}${
      safe.requestId ? ` — requestId=${safe.requestId}` : ""
    }`;
  }
}

module.exports = {
  getAI,
  getAIImage,
  getTranscription,
  getTTS,
  getDescription,
};

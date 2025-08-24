// image.js — v1.2
// Tool: getImage
// - erzeugt wahlweise ein "Prompt-Polishing" via getAI(), ruft dann getAIImage()
// - bricht NICHT mehr ab, wenn getAI() ohne Kontext aufgerufen würde (wir liefern eigenen Mini-Kontext)
// - gibt am Ende eine kurze Textantwort (URL + Prompt) zurück, wie bisher im Log zu sehen

const { getAI, getAIImage } = require("./aiService.js");

// Kleine, lokale Name-Sanitization (gleiches Prinzip wie in aiCore/aiService)
function cleanName(name) {
  if (!name) return undefined;
  let s = String(name)
    .trim()
    .replace(/[\s<|\\/>\u0000-\u001F]/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  s = s.slice(0, 64);
  if (!s) return undefined;
  const reserved = new Set(["assistant", "user", "system", "tool"]);
  if (reserved.has(s.toLowerCase())) return undefined;
  return s;
}

/**
 * getImage tool entry
 * @param {{ name:string, arguments:string }} func - tool_call.function
 * @param {*} context - handoverContext aus aiCore (wird NICHT vorausgesetzt)
 * @returns {Promise<string>} - Textantwort mit URL und Prompt
 */
module.exports = async function getImage(func, context) {
  let args = {};
  try {
    args = JSON.parse(func.arguments || "{}");
  } catch (e) {
    console.error("[getImage] Invalid JSON in arguments:", func.arguments);
    return "[ERROR]: getImage(): invalid JSON in arguments.";
  }

  const originalPrompt = (args.prompt || "").toString().trim();
  const size = (args.size || "1024x1024");
  const requester = cleanName(args.user_id || "user");

  if (!originalPrompt) {
    return "[ERROR]: getImage(): 'prompt' is required.";
  }

  // Optionales Prompt-Polishing via getAI() — aber jetzt IMMER mit eigenem Mini-Kontext.
  // Du kannst das per ENV togglen: IMAGE_PROMPT_POLISH=0 (aus) / 1 (an). Default: an.
  const doPolish = (process.env.IMAGE_PROMPT_POLISH ?? "1") !== "0";
  let finalPrompt = originalPrompt;

  if (doPolish) {
    const miniContext = {
      messages: [
        {
          role: "system",
          content:
            "You are an expert prompt writer for image generation. Rewrite the user's prompt to be concise, vivid, and strictly visual. Keep concrete nouns, materials, lighting, camera angle, composition, environment; avoid meta-talk and code fences. Return only the improved prompt."
        },
        {
          role: "user",
          name: requester,
          content: originalPrompt
        }
      ]
    };

    try {
      console.log("DEBUG:getImage → Polishing prompt via getAI()");
      const improved = await getAI(miniContext, 600, "gpt-4o");
      if (improved && improved.trim()) {
        finalPrompt = improved.trim();
      } else {
        console.log("DEBUG:getImage → Polishing returned empty; using original prompt.");
      }
    } catch (e) {
      // Kein Abbruch mehr – einfach Original weiterverwenden
      console.warn("WARN:getImage → Polishing failed; using original prompt.", e?.message || e);
      finalPrompt = originalPrompt;
    }
  }

  // Bild generieren
  try {
    const url = await getAIImage(finalPrompt, size, process.env.IMAGE_MODEL || "dall-e-3");

    // Einheitliches Rückgabeformat (wie bisher in deinen Logs)
    const out =
      `${url}\n\n` +
      `Prompt: ${finalPrompt}`;
    return out;
  } catch (e) {
    console.error("[getImage] getAIImage failed:", e?.message || e);
    return "[ERROR]: getImage(): image generation failed.";
  }
};

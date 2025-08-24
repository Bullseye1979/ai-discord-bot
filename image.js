// image.js — v1.2 (robust)
// Improve the prompt for an image and generate it. Return it as an URL

const { getAI, getAIImage } = require("./aiService.js");
const { getShortURL } = require("./helper.js");
const Context = require("./context.js");
const { IMAGEPROMPT } = require("./config.js");

const VALID_SIZES = new Set(["1024x1024", "1792x1024", "1024x1792"]);

async function getImage(toolFunction /*, handoverContext, getAIResponse, runtime */) {
  try {
    const args = JSON.parse(toolFunction.arguments || "{}");
    const userId = args.user_id || "user";
    const rawPrompt = String(args.prompt || "").trim();
    if (!rawPrompt) throw new Error("[ERROR]: Missing 'prompt'");

    const size = VALID_SIZES.has(args.size) ? args.size : "1024x1024";

    // 1) Prompt verbessern – robust & mit Fallback
    let improvedPrompt = rawPrompt;
    try {
      const ctx = new Context();
      if (IMAGEPROMPT && IMAGEPROMPT.trim()) {
        ctx.add("system", userId, IMAGEPROMPT.trim());
      } else {
        ctx.add(
          "system",
          userId,
          "You refine concise, visual-only prompts for image generation. Keep it under ~60 words, avoid text/logos/brands/UI."
        );
      }
      ctx.add("user", userId, `Original image description: "${rawPrompt}"`);

      // 3.5 ist oft abgeschaltet → nimm was stabiles/schnelles
      const gptResponse = await getAI(ctx, 400, "gpt-3.5-turbo");
      const candidate = (gptResponse || "").trim();
      if (candidate) improvedPrompt = candidate;
    } catch {
      // fallback: rawPrompt
    }

    // 2) Bild generieren
    const imageUrl = await getAIImage(improvedPrompt, size);
    if (!imageUrl) throw new Error("[ERROR]: No image URL received");

    // 3) Shortener optional – Fehler egal
    let finalUrl = imageUrl;
    try {
      const shortUrl = await getShortURL(imageUrl);
      if (shortUrl && typeof shortUrl === "string") finalUrl = shortUrl;
    } catch { /* ignore */ }

    return `${finalUrl}\n\nPrompt: ${improvedPrompt}`;
  } catch (error) {
    return `[ERROR]: Image could not be generated (${error?.message || "unknown error"})`;
  }
}

module.exports = { getImage };

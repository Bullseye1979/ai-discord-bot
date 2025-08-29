// image.js — clean v1.3
// Generate an improved image prompt and return a generated image URL (optionally shortened).

const { getAI, getAIImage } = require("./aiService.js");
const { getShortURL } = require("./helper.js");
const Context = require("./context.js");
const { IMAGEPROMPT } = require("./config.js");

const VALID_SIZES = new Set(["1024x1024", "1792x1024", "1024x1792"]);

/** Tool entry: refine a concise visual prompt and generate an image URL. */
async function getImage(toolFunction) {
  try {
    const args =
      typeof toolFunction.arguments === "string"
        ? JSON.parse(toolFunction.arguments || "{}")
        : (toolFunction.arguments || {});
    const userId = String(args.user_id || "user");
    const rawPrompt = String(args.prompt || "").trim();
    if (!rawPrompt) return "[ERROR]: IMG_INPUT — Missing 'prompt'.";

    const requestedSize = String(args.size || "").trim();
    const size = VALID_SIZES.has(requestedSize) ? requestedSize : "1024x1024";

    let improvedPrompt = rawPrompt;
    try {
      const ctx = new Context();
      const sys = (IMAGEPROMPT && IMAGEPROMPT.trim())
        ? IMAGEPROMPT.trim()
        : "You refine concise, purely visual prompts for image generation. ~60 words max. Avoid text, logos, brands, UI, watermarks.";
      await ctx.add("system", userId, sys);
      await ctx.add("user", userId, `Original image description:\n${rawPrompt}`);
      const refined = (await getAI(ctx, 300, "gpt-4o-mini"))?.trim();
      if (refined) improvedPrompt = refined;
    } catch {
      /* keep rawPrompt as fallback */
    }

    const imageUrl = await getAIImage(improvedPrompt, size);
    if (!imageUrl) return "[ERROR]: IMG_EMPTY — No image URL received from generator.";

    let finalUrl = imageUrl;
    try {
      const shortUrl = await getShortURL(imageUrl);
      if (shortUrl && typeof shortUrl === "string") finalUrl = shortUrl;
    } catch {
      /* ignore shortener errors */
    }

    return `${finalUrl}\n\nPrompt: ${improvedPrompt}`;
  } catch (err) {
    const msg = err?.message || "unexpected error";
    return `[ERROR]: IMG_UNEXPECTED — ${msg}`;
  }
}

module.exports = { getImage };

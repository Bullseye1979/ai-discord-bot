// image.js — robust v1.6
// Generate an improved image prompt and return a generated image URL (optionally shortened).
// - Tolerant args parsing (broken JSON → fallback to raw string as prompt)
// - Cleans code fences / prefixes like "Original image description:"
// - Always returns JSON: { ok, url?, url_short?, prompt?, size?, model?, error?, code? }



const { getAI, getAIImage } = require("./aiService.js");
const { getShortURL } = require("./helper.js");
const Context = require("./context.js");
const { IMAGEPROMPT } = require("./config.js");

const VALID_SIZES = new Set(["1024x1024", "1792x1024", "1024x1792"]);

function cleanPrompt(raw) {
  let s = String(raw || "");

  // strip code fences ```...``` incl. ```json
  s = s.replace(/^```(?:json|md)?\s*/i, "").replace(/```$/i, "");

  // remove “Original image description:” / “Prompt:” prefixes
  s = s.replace(/^\s*(original\s+image\s+description|prompt)\s*:\s*/i, "");

  // collapse whitespace
  s = s.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  // remove full-string quotes if present
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }

  return s.trim();
}

/** Best-effort argument parser:
 *  - If JSON.parse works → use it
 *  - If not → strip code fences and try again
 *  - If still not → treat the entire string as { prompt }
 */
function coerceArgs(toolFunction) {
  const raw = toolFunction?.arguments;

  if (raw && typeof raw === "object") {
    const prompt = cleanPrompt(raw.prompt || "");
    const size = (raw.size && String(raw.size)) || "1024x1024";
    const user_id = raw.user_id ? String(raw.user_id) : "";
    return { prompt, size, user_id };
  }

  if (typeof raw === "string") {
    const str = raw.trim();
    // try strict JSON
    try {
      const obj = JSON.parse(str);
      const prompt = cleanPrompt(obj.prompt || "");
      const size = (obj.size && String(obj.size)) || "1024x1024";
      const user_id = obj.user_id ? String(obj.user_id) : "";
      return { prompt, size, user_id };
    } catch (_) {
      // strip code fences and try again
      const s2 = str.replace(/^```(?:json|md)?\s*/i, "").replace(/```$/i, "");
      try {
        const obj = JSON.parse(s2);
        const prompt = cleanPrompt(obj.prompt || "");
        const size = (obj.size && String(obj.size)) || "1024x1024";
        const user_id = obj.user_id ? String(obj.user_id) : "";
        return { prompt, size, user_id };
      } catch (_) {
        // fallback: treat as prompt
        const prompt = cleanPrompt(str);
        return { prompt, size: "1024x1024", user_id: "" };
      }
    }
  }

  return { prompt: "", size: "1024x1024", user_id: "" };
}

/** Tool entry: refine a concise visual prompt and generate an image URL. */
async function getImage(toolFunction) {
  try {
    const args = coerceArgs(toolFunction);

    // validate prompt
    if (!args.prompt) {
      return JSON.stringify({ ok: false, error: "Missing 'prompt' after parsing", code: "IMG_INPUT" });
    }

    // validate size
    const requestedSize = String(args.size || "").trim();
    const size = VALID_SIZES.has(requestedSize) ? requestedSize : "1024x1024";

    // improve prompt via small LLM (best-effort)
    let improvedPrompt = args.prompt;
    try {
      const ctx = new Context();
      const sys = (IMAGEPROMPT && IMAGEPROMPT.trim())
        ? IMAGEPROMPT.trim()
        : "You refine concise, purely visual prompts for image generation. ~60 words max. Avoid text, logos, brands, UI, watermarks.";
      await ctx.add("system", args.user_id || "user", sys);
      await ctx.add("user", args.user_id || "user", `Original image description:\n${args.prompt}`);
      const refined = (await getAI(ctx, 300, "gpt-4o-mini"))?.trim();
      if (refined) improvedPrompt = cleanPrompt(refined);
    } catch {
      /* keep raw prompt as fallback */
    }

    const model = process.env.IMAGE_MODEL || "dall-e-3";

    // optional debug (safe preview)
    try {
      console.log("getAIImage →", {
        model,
        size,
        prompt_preview: improvedPrompt.slice(0, 160)
      });
    } catch {}

    const imageUrl = await getAIImage(improvedPrompt, size, model);
    if (!imageUrl) {
      return JSON.stringify({ ok: false, error: "No image URL received from generator", code: "IMG_EMPTY" });
    }

    // optional shortener
    let finalUrl = imageUrl;
    try {
      const shortUrl = await getShortURL(imageUrl);
      if (shortUrl && typeof shortUrl === "string") finalUrl = shortUrl;
      return JSON.stringify({
        ok: true,
        url: imageUrl,
        url_short: finalUrl !== imageUrl ? finalUrl : null,
        prompt: improvedPrompt,
        size,
        model
      });
    } catch {
      return JSON.stringify({
        ok: true,
        url: imageUrl,
        url_short: null,
        prompt: improvedPrompt,
        size,
        model
      });
    }
  } catch (err) {
    const msg = err?.message || "unexpected error";
    return JSON.stringify({ ok: false, error: msg, code: "IMG_UNEXPECTED" });
  }
}

module.exports = { getImage };

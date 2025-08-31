// image.js — robust v1.9
// Generate an improved image prompt and return a generated image URL (optionally shortened).
// - Tolerant args parsing (broken JSON → fallback to raw string as prompt)
// - Cleans code fences & prefixes; removes nasty chars and unmatched quotes
// - 3-step fallback on 5xx / "unable to process" (refined → simplified refined → simplified raw)
// - Extracts requestId, returns structured JSON { ok, url?, url_short?, prompt?, size?, model?, error?, code?, requestId?, attempts? }

const { getAI, getAIImage } = require("./aiService.js");
const { getShortURL } = require("./helper.js");
const Context = require("./context.js");
const { IMAGEPROMPT } = require("./config.js");

const VALID_SIZES = new Set(["1024x1024", "1792x1024", "1024x1792"]);

function cleanPromptBasic(raw) {
  let s = String(raw || "");

  // strip code fences ```...``` incl. ```json
  s = s.replace(/^```(?:json|md)?\s*/i, "").replace(/```$/i, "");

  // remove “Original image description:” / “Prompt:” prefixes
  s = s.replace(/^\s*(original\s+image\s+description|prompt)\s*:\s*/i, "");

  // collapse whitespace
  s = s.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  // remove wrapping quotes if the entire string is quoted
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }

  return s.trim();
}

function simplifyForImage(p) {
  let s = String(p || "").trim();

  // remove URLs
  s = s.replace(/https?:\/\/\S+/gi, "");

  // normalize punctuation & remove risky/unmatched quotes/backticks
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  s = s.replace(/[`"'<>]/g, ""); // remove all quotes/backticks/angle brackets to avoid parser hiccups

  // remove brackets that sometimes cause parser trouble
  s = s.replace(/[\[\](){}]/g, "");

  // replace multiple dashes/underscores
  s = s.replace(/[-_]{2,}/g, " ");

  // collapse whitespace again
  s = s.replace(/\s{2,}/g, " ").trim();

  // hard clip (just in case)
  const MAX = 700;
  if (s.length > MAX) s = s.slice(0, MAX);

  // ensure it ends cleanly
  if (!/[.!?]$/.test(s)) s += ".";

  return s;
}

/** Best-effort argument parser (string|object) */
function coerceArgs(toolFunction) {
  const raw = toolFunction?.arguments;

  if (raw && typeof raw === "object") {
    const prompt = cleanPromptBasic(raw.prompt || "");
    const size = (raw.size && String(raw.size)) || "1024x1024";
    const user_id = raw.user_id ? String(raw.user_id) : "";
    return { prompt, size, user_id };
  }

  if (typeof raw === "string") {
    const str = raw.trim();
    // try strict JSON
    try {
      const obj = JSON.parse(str);
      const prompt = cleanPromptBasic(obj.prompt || "");
      const size = (obj.size && String(obj.size)) || "1024x1024";
      const user_id = obj.user_id ? String(obj.user_id) : "";
      return { prompt, size, user_id };
    } catch (_) {
      // strip code fences and try again
      const s2 = str.replace(/^```(?:json|md)?\s*/i, "").replace(/```$/i, "");
      try {
        const obj = JSON.parse(s2);
        const prompt = cleanPromptBasic(obj.prompt || "");
        const size = (obj.size && String(obj.size)) || "1024x1024";
        const user_id = obj.user_id ? String(obj.user_id) : "";
        return { prompt, size, user_id };
      } catch (_) {
        // fallback: treat the whole string as the prompt
        const prompt = cleanPromptBasic(str);
        return { prompt, size: "1024x1024", user_id: "" };
      }
    }
  }

  return { prompt: "", size: "1024x1024", user_id: "" };
}

function extractRequestId(err) {
  try {
    const msg = err?.response?.data?.error?.message || err?.message || "";
    const m = msg.match(/\breq_[a-z0-9]+/i);
    return m ? m[0] : null;
  } catch { return null; }
}

function isServerSideImageError(err) {
  const st = err?.response?.status || 0;
  const msg = String(err?.response?.data?.error?.message || err?.message || "");
  return st >= 500 || /unable to process your prompt/i.test(msg);
}

/** Tool entry: refine a concise visual prompt and generate an image URL. */
async function getImage(toolFunction) {
  const attemptsMeta = [];
  try {
    const args = coerceArgs(toolFunction);

    if (!args.prompt) {
      return JSON.stringify({ ok: false, error: "Missing 'prompt' after parsing", code: "IMG_INPUT" });
    }

    const requestedSize = String(args.size || "").trim();
    const size = VALID_SIZES.has(requestedSize) ? requestedSize : "1024x1024";
    const model = process.env.IMAGE_MODEL || "dall-e-3";

    // 1) Improve prompt via small LLM (best-effort)
    let improvedPrompt = args.prompt;
    try {
      const ctx = new Context();
      const sys = (IMAGEPROMPT && IMAGEPROMPT.trim())
        ? IMAGEPROMPT.trim()
        : "You refine concise, purely visual prompts for image generation. ~60 words max. Avoid text, logos, brands, UI, watermarks.";
      await ctx.add("system", args.user_id || "user", sys);
      await ctx.add("user",   args.user_id || "user", `Original image description:\n${args.prompt}`);
      const refined = (await getAI(ctx, 300, "gpt-4o-mini"))?.trim();
      if (refined) improvedPrompt = cleanPromptBasic(refined);
    } catch {
      // keep raw prompt as fallback
    }

    // Three attempts:
    // A) refined as-is
    // B) simplified(refined)
    // C) simplified(raw)
    const candidates = [
      { label: "refined", prompt: improvedPrompt },
      { label: "simplified_refined", prompt: simplifyForImage(improvedPrompt) },
      { label: "simplified_raw", prompt: simplifyForImage(args.prompt) },
    ];

    for (const cand of candidates) {
      const preview = cand.prompt.slice(0, 200);
      try {
        try {
          console.log("getAIImage →", { model, size, attempt: cand.label, prompt_preview: preview });
        } catch {}

        const imageUrl = await getAIImage(cand.prompt, size, model);
        if (!imageUrl) {
          attemptsMeta.push({ attempt: cand.label, status: "no_url" });
          continue;
        }

        let finalUrl = imageUrl;
        try {
          const shortUrl = await getShortURL(imageUrl);
          if (shortUrl && typeof shortUrl === "string") finalUrl = shortUrl;
        } catch {}

        // success
        return JSON.stringify({
          ok: true,
          url: imageUrl,
          url_short: finalUrl !== imageUrl ? finalUrl : null,
          prompt: cand.prompt,
          size,
          model,
          attempts: attemptsMeta
        });
      } catch (err) {
        const reqId = extractRequestId(err);
        const servery = isServerSideImageError(err);
        attemptsMeta.push({
          attempt: cand.label,
          status: "error",
          code: servery ? "IMG_SERVER" : "IMG_CLIENT",
          requestId: reqId || null,
          statusCode: err?.response?.status || null
        });

        // only continue to next attempt if it looks server-side / "unable to process"
        if (!servery) break;
        // else try next simplified prompt
      }
    }

    // all attempts failed
    return JSON.stringify({
      ok: false,
      error: "Image generation failed after retries",
      code: "IMG_FAIL",
      attempts: attemptsMeta
    });
  } catch (err) {
    const reqId = extractRequestId(err);
    return JSON.stringify({
      ok: false,
      error: err?.message || "unexpected error",
      code: "IMG_UNEXPECTED",
      requestId: reqId || null,
      attempts: attemptsMeta
    });
  }
}

module.exports = { getImage };

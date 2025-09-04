// image.js — persistent v2.0
// Generate an improved image prompt → create image via OpenAI → DOWNLOAD it locally
// Saves to: <repo>/documents/pictures/<filename>.png
// Returns JSON string: { ok, url, file, prompt, size, model, attempts?, error?, code? }
//
// Notes:
// - No URL shortener. We return PUBLIC_BASE_URL + '/documents/pictures/<file>' for durability.
// - Keeps 3-step fallback (refined → simplified refined → simplified raw)
// - Tolerant arg parsing (string/object/```json fences/quotes)
// - Always returns a JSON STRING (never throws uncaught), suitable for tool replies.

require("dotenv").config();

const axios = require("axios");
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");

const { getAI, getAIImage } = require("./aiService.js");
const Context = require("./context.js");
const { IMAGEPROMPT } = require("./config.js");

/* -------------------------------- Constants -------------------------------- */

const VALID_SIZES = new Set(["1024x1024", "1792x1024", "1024x1792"]);
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_MODEL = process.env.IMAGE_MODEL || "dall-e-3";
const PICTURES_DIR = path.join(__dirname, "documents", "pictures");

/* --------------------------------- Debug ----------------------------------- */

const IMG_DEBUG = String(process.env.IMG_DEBUG || "").toLowerCase() === "1" ||
                  String(process.env.IMG_DEBUG || "").toLowerCase() === "true";

function dbg(...args) {
  if (IMG_DEBUG) {
    try { console.log("[IMG_DEBUG]", ...args); } catch {}
  }
}

/* ----------------------------- Helper functions ---------------------------- */

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
  s = s.replace(/[`"'<>]/g, ""); // remove quotes/backticks/angle brackets to avoid parser hiccups
  // remove brackets that sometimes cause parser trouble
  s = s.replace(/[\[\](){}]/g, "");
  // replace multiple dashes/underscores
  s = s.replace(/[-_]{2,}/g, " ");
  // collapse whitespace again
  s = s.replace(/\s{2,}/g, " ").trim();
  // hard clip
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
    const size = (raw.size && String(raw.size)) || DEFAULT_SIZE;
    const user_id = raw.user_id ? String(raw.user_id) : "";
    return { prompt, size, user_id };
  }

  if (typeof raw === "string") {
    const str = raw.trim();
    // try strict JSON
    try {
      const obj = JSON.parse(str);
      const prompt = cleanPromptBasic(obj.prompt || "");
      const size = (obj.size && String(obj.size)) || DEFAULT_SIZE;
      const user_id = obj.user_id ? String(obj.user_id) : "";
      return { prompt, size, user_id };
    } catch (_) {
      // strip code fences and try again
      const s2 = str.replace(/^```(?:json|md)?\s*/i, "").replace(/```$/i, "");
      try {
        const obj = JSON.parse(s2);
        const prompt = cleanPromptBasic(obj.prompt || "");
        const size = (obj.size && String(obj.size)) || DEFAULT_SIZE;
        const user_id = obj.user_id ? String(obj.user_id) : "";
        return { prompt, size, user_id };
      } catch (_) {
        // fallback: treat the whole string as the prompt
        const prompt = cleanPromptBasic(str);
        return { prompt, size: DEFAULT_SIZE, user_id: "" };
      }
    }
  }

  return { prompt: "", size: DEFAULT_SIZE, user_id: "" };
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

function ensureAbsoluteUrl(urlPath) {
  const base = (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "").replace(/\/$/, "");
  if (/^https?:\/\//i.test(urlPath)) return urlPath;
  if (base) return `${base}${urlPath.startsWith("/") ? "" : "/"}${urlPath}`;
  return urlPath; // relative fallback
}

function pickExtFromContentType(ct) {
  const s = String(ct || "").toLowerCase();
  if (s.includes("image/png")) return ".png";
  if (s.includes("image/jpeg") || s.includes("image/jpg")) return ".jpg";
  if (s.includes("image/webp")) return ".webp";
  if (s.includes("image/gif")) return ".gif";
  return ".png"; // default
}

function safeBaseFromPrompt(prompt) {
  const s = String(prompt || "").toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return s || "image";
}

/** Download remote image URL to local /documents/pictures, return { filePath, publicUrl, filename } */
async function downloadImageToLocal(imageUrl, prompt = "") {
  await fs.mkdir(PICTURES_DIR, { recursive: true });

  // Fetch binary
  const res = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 120000 });
  const buf = Buffer.from(res.data);
  const ext = pickExtFromContentType(res.headers?.["content-type"]);

  // Filename: <slug>-<timestamp>-<shorthex><ext>
  const slug = safeBaseFromPrompt(prompt);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(4).toString("hex");
  const filename = `${slug}-${ts}-${rand}${ext}`;

  const filePath = path.join(PICTURES_DIR, filename);
  await fs.writeFile(filePath, buf);

  // Build public URL
  const publicUrl = ensureAbsoluteUrl(`/documents/pictures/${filename}`);
  return { filePath, publicUrl, filename };
}

/* --------------------------------- Tool ------------------------------------ */

/** Tool entry: refine a concise visual prompt, generate an image, DOWNLOAD it locally, return public URL. */
async function getImage(toolFunction) {
  const attemptsMeta = [];
  try {
    const args = coerceArgs(toolFunction);

    if (!args.prompt) {
      return JSON.stringify({ ok: false, error: "Missing 'prompt' after parsing", code: "IMG_INPUT" });
    }

    const requestedSize = String(args.size || "").trim();
    const size = VALID_SIZES.has(requestedSize) ? requestedSize : DEFAULT_SIZE;
    const model = DEFAULT_MODEL;

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

        const remoteUrl = await getAIImage(cand.prompt, size, model);
        if (!remoteUrl) {
          attemptsMeta.push({ attempt: cand.label, status: "no_url" });
          continue;
        }

        // Download immediately (SAS links expire)
        const { publicUrl, filePath, filename } = await downloadImageToLocal(remoteUrl, cand.prompt);

        // success
        dbg("Saved image:", { filePath, publicUrl });
        return JSON.stringify({
          ok: true,
          url: publicUrl,         // durable URL based on PUBLIC_BASE_URL
          file: `/documents/pictures/${filename}`, // relative path (if needed)
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
          statusCode: err?.response?.status || null,
          message: err?.message || String(err)
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

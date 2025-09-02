// pdf.js — v3.4
// Generic PDF generator; AI-merging stylesheet (Base + Prompt → Final CSS).
// Robust image handling: improves weak {…} image descriptions before calling getAIImage.
// No assumptions about content type; images optional; no inline styles/classes/ids in HTML.

const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");

const Context = require("./context");
const { getAIImage, getAI } = require("./aiService");
const { getPlainFromHTML } = require("./helper.js");
const { reportError } = require("./error.js");

/** CONFIG */
const MAX_SEGMENTS = 25;
const IMAGE_SIZE = "1024x1024"; // forwarded to getAIImage if supported by your service
const MAX_IMAGES = 999;         // lower if you want to hard-limit auto image generation per document

/** FS-safe, lowercased filename (max 40 chars, no extension). */
function normalizeFilename(s, fallback = "document") {
  const base =
    String(s || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || fallback;
  return base;
}

/** Ask the model for a short filename suggestion and then sanitize it. */
async function suggestFilename(originalPrompt, prompt) {
  try {
    const req = new Context();
    await req.add(
      "user",
      "",
      `Generate a lowercase filename (<= 40 chars), only letters/numbers/spaces, no extension. Return just the name:\n\n${originalPrompt}\n\n${prompt}`
    );
    const raw = await getAI(req, 50, "gpt-4o-mini");
    return normalizeFilename(raw?.trim());
  } catch (err) {
    await reportError(err, null, "PDF_SUGGEST_FILENAME", "WARN");
    return normalizeFilename("");
  }
}

/* ------------------------- Image placeholder handling ------------------------- */

/** Heuristic: is the image description too generic/weak to yield a good result? */
function isWeakImageDesc(desc) {
  const s = String(desc || "").trim().toLowerCase();
  if (!s) return true;
  const wc = s.split(/\s+/).length;
  if (wc < 6) return true; // very short → likely weak

  // very generic nouns that often appear without detail
  const generic = [
    "image", "picture", "photo", "portrait", "character portrait", "logo",
    "icon", "banner", "header image", "cover image", "illustration",
    "diagram", "chart", "graph"
  ];
  if (generic.includes(s)) return true;

  for (const g of generic) {
    if (s === g) return true;
    // "portrait of", "image of", etc. with very little tail
    if ((s.startsWith(g + " of ") || s.startsWith(g + " with ")) && wc <= 6) {
      return true;
    }
  }
  return false;
}

/** Expand a vague image idea into a detailed, safe description. */
async function enhanceImagePrompt(brief, htmlContext) {
  try {
    const ctx = new Context();
    await ctx.add(
      "system",
      "",
      "You transform a vague image idea into a detailed, concrete, safe prompt for a general image generator.\n" +
        "Rules: 30–90 words. Describe subject, setting, composition, mood, lighting, style/materials. " +
        "No text/watermarks/logos. No brand names or copyrighted characters.\n" +
        "Be faithful to the provided HTML context; do not invent proper names. Return the description only."
    );
    await ctx.add(
      "assistant",
      "",
      `HTML context (may be truncated):\n${String(htmlContext || "").slice(0, 4000)}`
    );
    await ctx.add("user", "", `Expand this into a rich visual prompt:\n"${brief}"`);

    const out = await getAI(ctx, 200, "gpt-4o-mini");
    const clean = String(out || "").trim();
    return clean || brief;
  } catch {
    return brief;
  }
}

/** Replace {natural language image description} placeholders with generated image URLs (if any). */
async function resolveImagePlaceholders(html) {
  const originalMatches = [...String(html || "").matchAll(/\{([^}]+)\}/g)];
  const originals = originalMatches.map((m) => m[1]);
  if (!originals.length) return { html, imagelist: "" };

  const uniqueOriginals = [...new Set(originals)];
  const generationPlan = []; // [{ original, effective, skipped }]

  for (const orig of uniqueOriginals) {
    let effective = orig;
    if (isWeakImageDesc(effective)) {
      const improved = await enhanceImagePrompt(effective, html);
      if (!isWeakImageDesc(improved)) {
        effective = improved;
      } else {
        generationPlan.push({ original: orig, effective: null, skipped: true });
        continue;
      }
    }
    generationPlan.push({ original: orig, effective, skipped: false });
  }

  // Optional hard cap
  const limitedPlan = generationPlan.slice(0, MAX_IMAGES);

  const urlMap = new Map();  // original placeholder -> final URL
  const imagelist = [];

  for (const item of limitedPlan) {
    const { original, effective, skipped } = item;
    if (skipped) {
      imagelist.push(`${original}  :  [SKIPPED — insufficient detail]`);
      continue;
    }
    try {
      const url = await getAIImage(effective, IMAGE_SIZE, "dall-e-3");
      if (url) {
        urlMap.set(original, url);
        imagelist.push(`${effective}  :  ${url}`);
      } else {
        imagelist.push(`${effective}  :  [FAILED — no URL returned]`);
      }
    } catch (err) {
      await reportError(err, null, "PDF_IMAGE_GEN", "WARN");
      imagelist.push(`${effective}  :  [ERROR — generation failed]`);
    }
  }

  // Replace only originals for which we have URLs
  let withImages = html;
  for (const [orig, url] of urlMap.entries()) {
    const esc = orig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\{\\s*${esc}\\s*\\}`, "g");
    withImages = withImages.replace(re, url);
  }

  return { html: withImages, imagelist: imagelist.join("\n") };
}

/* ------------------------- Design Hardening ------------------------- */

/** Remove ALL class/id/style attributes from generated HTML (global). */
function sanitizeDesign(html) {
  if (!html) return "";
  return String(html).replace(/\s+(class|id|style)=(".*?"|'.*?'|[^\s>]+)/gi, "");
}

/** CSS sanitizer: keep only safe rules (element selectors, @page/@media print), no @import/url(), no classes/IDs. */
function sanitizeCss(css) {
  let s = String(css || "");
  s = s.replace(/@import[\s\S]*?;?/gi, "");
  s = s.replace(/url\s*\(\s*['"]?[^)]*\)/gi, "");
  s = s.replace(/!important/gi, "");
  s = s.replace(/@(?!page|media)[^{]+\{[^}]*\}/gi, "");
  s = s.replace(/@media(?!\s+print)[^{]+\{[^}]*\}/gi, "");
  // Drop rules containing class/id/universal selectors (., #, *)
  s = s.replace(/(^|\})\s*[^@][^{]*[.#\*][^{]*\{[^}]*\}/g, "$1");
  return s.trim();
}

/** Strong, modern magazine-like Base CSS (element selectors only; rounded corners for images; 2 columns default). */
function getBaseMagazineCss() {
  return [
    "@page{size:A4;margin:20mm}",
    "html,body{margin:0;padding:0}",
    "body{font-family:Arial,Helvetica,sans-serif;font-size:12pt;line-height:1.6;color:#111;column-count:2;column-gap:12mm}",
    // headings
    "h1{font-size:22pt;margin:0 0 .5rem 0;line-height:1.25;color:#0a66c2;break-after:avoid}",
    "h2{font-size:16pt;margin:1.2rem 0 .5rem 0;line-height:1.25;color:#0a66c2;break-after:avoid}",
    "h3{font-size:13pt;margin:1rem 0 .4rem 0;line-height:1.25;color:#0a66c2;break-after:avoid}",
    // text & lists
    "p{margin:.6rem 0;text-align:justify}",
    "ul,ol{margin:.6rem 0 .6rem 1.2rem}",
    "li{margin:.2rem 0}",
    "blockquote{margin:.8rem 0;padding:.6rem 1rem;border-left:3px solid #0a66c2;color:#555;break-inside:avoid}",
    "hr{border:0;border-top:1px solid #ddd;margin:1rem 0;break-after:avoid}",
    // images & figures
    "img{max-width:100%;height:auto;display:block;margin:0 auto 8mm;page-break-inside:avoid;border-radius:12px}",
    "figure{break-inside:avoid;page-break-inside:avoid;margin:0 0 8mm 0}",
    "figcaption{text-align:center;font-size:10pt;opacity:.75}",
    // tables (colored/zebra)
    "table{border-collapse:collapse;width:100%;break-inside:avoid;margin:.6rem 0}",
    "thead th{background:#0a66c2;color:#fff;padding:.45rem .6rem;text-align:left}",
    "tbody tr:nth-child(even){background:#f6f8fa}",
    "th,td{border:1px solid #d0d7de;padding:.35rem .5rem;vertical-align:top}",
    // code/pre
    "code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10pt}",
    "pre{white-space:pre-wrap;background:#f8f8f8;border:1px solid #ddd;padding:.6rem}",
    "figure,table{page-break-inside:avoid}",
  ].join("");
}

/**
 * Ask the KI to MERGE the Base CSS with the user's style brief and return a FULL final stylesheet.
 * No deterministic rules; the KI must keep defaults unless explicitly changed by the brief.
 */
async function mergeBaseCssWithBrief(baseCss, styleBrief) {
  const req = new Context();
  await req.add(
    "system",
    "",
    "You are a senior print/CSS designer. You will receive a STRONG DEFAULT CSS for an A4, magazine-like layout " +
      "and a user style brief describing desired deviations. Your job: produce a SINGLE, FINAL CSS STYLESHEET " +
      "that starts from the default and applies ONLY the changes explicitly requested by the brief. " +
      "Keep everything else as in the default. Do NOT invent unrelated changes.\n\n" +
      "HARD RULES:\n" +
      "• Use ONLY element selectors (html, body, h1,h2,h3,p,ul,ol,li,table,thead,tbody,tr,th,td,blockquote,figure,figcaption,code,pre,img,hr).\n" +
      "• No classes, no IDs, no @import, no url().\n" +
      "• You MAY use @page and @media print.\n" +
      "• The result must be COMPLETE (not a diff/patch), minified or compact OK, but human-readable is preferred.\n" +
      "• Images must fit the page (img{max-width:100%;height:auto}) and avoid page-breaks inside figures.\n" +
      "• Maintain modern magazine look and colored tables by default. Rounded corners for images by default."
  );
  await req.add("assistant", "", `### DEFAULT BASE CSS\n${baseCss}`);
  await req.add(
    "user",
    "",
    `User style brief (may be empty):\n${String(styleBrief || "").trim()}\n\nReturn the FINAL COMPLETE CSS only (no comments, no explanations).`
  );

  const raw = await getAI(req, 1000, "gpt-4o-mini");
  return sanitizeCss(raw || "");
}

/** Generate final stylesheet purely via KI: Base → KI merges with brief → Final CSS. */
async function generateStylesheet(styleBrief = "") {
  const baseCss = getBaseMagazineCss();
  const finalCss = await mergeBaseCssWithBrief(baseCss, styleBrief);

  // Minimal safety-net: if KI returned empty/too tiny CSS, fall back to base.
  const css = (finalCss && finalCss.length > 200) ? finalCss : baseCss;

  // Cache by hash (optional; helpful if you expose themes)
  const hash = crypto.createHash("sha1").update(css).digest("hex").slice(0, 8);
  const documentsDir = path.join(__dirname, "documents");
  const cssDir = path.join(documentsDir, "css");
  await fs.mkdir(cssDir, { recursive: true });
  const cssPath = path.join(cssDir, `theme-${hash}.css`);
  await fs.writeFile(cssPath, css);

  return { css, cssPath, hash };
}

/* ------------------------- URL Helper ------------------------- */

function ensureAbsoluteUrl(urlPath) {
  const base = (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "").replace(/\/$/, "");
  if (/^https?:\/\//i.test(urlPath)) return urlPath;
  if (base) {
    return `${base}${urlPath.startsWith("/") ? "" : "/"}${urlPath}`;
  }
  return urlPath; // relative fallback
}

/* ------------------------- Main Tool Entry ------------------------- */

async function getPDF(toolFunction, context, getAIResponse) {
  let browser = null;
  try {
    const args =
      typeof toolFunction.arguments === "string"
        ? JSON.parse(toolFunction.arguments || "{}")
        : toolFunction.arguments || {};

    const prompt = String(args.prompt || "").trim();
    const original_prompt = String(args.original_prompt || "").trim();
    const user_id = String(args.user_id || "").trim();

    if (!prompt || !original_prompt || !user_id) {
      return "[ERROR]: PDF_INPUT — Missing 'prompt', 'original_prompt' or 'user_id'.";
    }

    // Build stylesheet purely via KI (Base + Prompt merged into final CSS)
    const { css } = await generateStylesheet(`${original_prompt}\n\n${prompt}`);

    // Strong output rules: no inline/class/id. NO content assumptions (any document).
    const generationContext = new Context(
      "You are a PDF generator that writes final, publish-ready HTML.",
      `### Output (STRICT):
- Output VALID HTML **inside <body> only** (no <html>/<head> tags).
- **NO inline styles, NO class=, NO id=** anywhere.
- Use only semantic tags: h1–h3, p, ul/ol/li, table/thead/tbody/tr/th/td, blockquote, figure, figcaption, img, hr, br, code, pre.
- Do **not** include explanations or comments—only HTML.
- Prefer rich, complete content (not just outlines).

### Continuation / Segments:
- If long, write in natural segments without artificial endings.
- Only append [FINISH] on a new line AFTER the last HTML tag when the document is fully complete.

### Images:
- Images are optional. If adding images, use <img src="{...}"> placeholders (no inline styles).
- Each placeholder description MUST be richly detailed (≥ 6 words) and concrete (subject, setting, style, lighting, composition).
- Avoid generic phrases like "image", "picture", "portrait", or "character portrait" without details.
- Do not mix real URLs and curly-brace descriptions in a single src.
- Figures should avoid page breaks; images must scale to fit.

### Consistency:
- Use only the most recent user prompt for intent.
- Use prior context only if it contains directly relevant source material (quotes, data, prior chapter).`,
      [],
      {},
      null,
      { skipInitialSummaries: true, persistToDB: false }
    );

    const formattedContext = Array.isArray(context?.messages)
      ? context.messages.map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join("\n\n")
      : "";

    await generationContext.add(
      "user",
      "",
      `Original chat context (use only directly relevant material):\n\n${formattedContext}\n\nOriginal User Prompt:\n${original_prompt}\n\nSpecific instructions:\n${prompt}`
    );

    // Lazy require to avoid circular dependency with tools.js
    const { getToolRegistry } = require("./tools.js");
    const allowTools = [
      "getWebpage",
      "getImage",
      "getGoogle",
      "getYoutube",
      "getLocation",
      "getHistory",
      "getImageDescription"
    ];
    const { tools: toolSpecs, registry: toolRegistry } = getToolRegistry(allowTools);

    let fullHTML = "";
    let persistentToolMessages = [];
    let segmentCount = 0;

    while (segmentCount < MAX_SEGMENTS) {
      const segmentCtx = new Context(
        "You generate the next HTML segment.",
        "",
        toolSpecs,
        toolRegistry,
        null,
        { skipInitialSummaries: true, persistToDB: false }
      );
      segmentCtx.messages = [...generationContext.messages];

      if (persistentToolMessages.length > 0) {
        const toolBlock = persistentToolMessages.map((m) => m.content).join("\n\n");
        await segmentCtx.add("assistant", "", "### Tool Results (context)\n\n" + toolBlock);
      }
      if (segmentCount > 0) {
        await segmentCtx.add("assistant", "", "### Previously Generated HTML\n\n" + fullHTML);
      }
      await segmentCtx.add(
        "user",
        "",
        "Continue immediately after the last segment. Add only new FINAL HTML content. Maintain structure and detail. No inline styles, classes, or ids. Do not output templates or bracketed hints."
      );

      const segmentHTML = await getAIResponse(segmentCtx, 700, 1, "gpt-4o");
      if (!segmentHTML || segmentHTML.length < 100) break;

      const newToolMsgs = segmentCtx.messages.filter((m) => m.role === "tool");
      for (const msg of newToolMsgs) {
        if (!persistentToolMessages.find((m) => m.tool_call_id === msg.tool_call_id)) {
          persistentToolMessages.push(msg);
        }
      }

      const cleaned = sanitizeDesign(segmentHTML.replace("[FINISH]", ""));
      fullHTML += cleaned;

      if (segmentHTML.includes("[FINISH]")) break;
      segmentCount++;
    }

    if (!fullHTML.trim()) {
      return "[ERROR]: PDF_EMPTY — No HTML content was generated.";
    }

    // Replace image placeholders AFTER design sanitization (with prompt enhancement for weak descriptors)
    const { html: htmlWithImages, imagelist } = await resolveImagePlaceholders(fullHTML);

    const styledHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>${css}</style>
</head>
<body>
  ${htmlWithImages}
</body>
</html>`;

    const documentsDir = path.join(__dirname, "documents");
    await fs.mkdir(documentsDir, { recursive: true });

    const suggested = await suggestFilename(original_prompt, prompt);
    const filename = normalizeFilename(suggested || "document");
    const publicPath = `/documents/${filename}.pdf`;
    const pdfPath = path.join(documentsDir, `${filename}.pdf`);

    let browserOpts = { headless: "new", args: ["--no-sandbox"] };
    browser = await puppeteer.launch(browserOpts);
    const page = await browser.newPage();
    await page.setContent(styledHtml, { waitUntil: "load" });
    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true
    });

    const publicUrl = ensureAbsoluteUrl(publicPath);

    const preview = getPlainFromHTML(htmlWithImages, 2000);
    const imagesNote = imagelist ? `\n\n### Images\n${imagelist}` : "";

    // Angle brackets help some chat clients render the URL as clickable.
    return `${preview}\n\nPDF: ${publicUrl}\n<${publicUrl}>${imagesNote}`;
  } catch (err) {
    await reportError(err, null, "PDF_UNEXPECTED", "FATAL");
    return "[ERROR]: PDF_UNEXPECTED — Could not generate PDF.";
  } finally {
    try { await browser?.close(); } catch {}
  }
}

module.exports = { getPDF };

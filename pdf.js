// pdf.js — v3.1 (AI-driven minimal CSS overrides atop a strong Magazine default)
// Generates multi-segment HTML via tools + model and renders to PDF. Returns short preview + absolute PDF URL.

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
const IMAGE_SIZE = "1024x1024"; // forwarded to getAIImage if supported
const MAX_IMAGES = 999;         // set to 1 if du strikt nur ein Bild willst

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

/** Replace {natural language image description} placeholders with generated image URLs. */
async function resolveImagePlaceholders(html) {
  const matches = [...String(html || "").matchAll(/\{([^}]+)\}/g)];
  const placeholders = matches.map((m) => m[1]);
  const map = {};
  const list = [];

  // Unique & optional limit
  const unique = [];
  for (const desc of placeholders) {
    if (!unique.includes(desc)) unique.push(desc);
  }
  const targets = unique.slice(0, MAX_IMAGES);

  for (const desc of targets) {
    if (map[desc]) continue;
    try {
      const url = await getAIImage(desc, IMAGE_SIZE, "dall-e-3");
      map[desc] = url;
      list.push(`${desc}  :  ${url}`);
    } catch (err) {
      await reportError(err, null, "PDF_IMAGE_GEN", "WARN");
    }
  }

  let withImages = html;
  for (const [desc, url] of Object.entries(map)) {
    if (!url) continue;
    const esc = desc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\{\\s*${esc}\\s*\\}`, "g");
    withImages = withImages.replace(re, url);
  }
  return { html: withImages, imagelist: list.join("\n") };
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

/** Strong Magazine Base CSS (element selectors only). */
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
    "img{max-width:100%;height:auto;display:block;margin:0 auto 8mm;page-break-inside:avoid}",
    "figure{break-inside:avoid;page-break-inside:avoid;margin:0 0 8mm 0}",
    "figure img:first-child{border-radius:50%}", // round portrait by default
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

/** Ask AI for minimal CSS overrides relative to the base. */
async function getAiCssOverrides(baseCss, styleBrief) {
  if (!String(styleBrief || "").trim()) return "";
  const req = new Context();
  await req.add(
    "system",
    "",
    "You are a professional print designer. You receive a strong default CSS (element selectors only) for an A4, magazine-like layout. " +
      "Your task: produce a MINIMAL CSS PATCH that ONLY changes aspects explicitly requested in the user brief. " +
      "Do NOT restate defaults. Do NOT remove features not mentioned. " +
      "Rules:\n" +
      "- Use ONLY element selectors (html, body, h1,h2,h3,p,ul,ol,li,table,thead,tbody,tr,th,td,blockquote,figure,figcaption,code,pre,img,hr).\n" +
      "- No classes, no IDs, no @import, no url().\n" +
      "- Prefer to touch as few properties as possible; keep the default look unless explicitly asked.\n" +
      "- You may use @page and @media print.\n" +
      "- Output CSS only (no comments/explanations)."
  );
  await req.add("assistant", "", `### DEFAULT BASE CSS\n${baseCss}`);
  await req.add(
    "user",
    "",
    `User style brief:\n${String(styleBrief || "").trim()}\n\nReturn only the minimal CSS overrides (a patch), nothing else.`
  );

  const raw = await getAI(req, 600, "gpt-4o-mini");
  return sanitizeCss(raw || "");
}

/** Generate final stylesheet: Base + minimal AI overrides derived from the brief. */
async function generateStylesheet(styleBrief = "") {
  const baseCss = getBaseMagazineCss();
  const overrides = await getAiCssOverrides(baseCss, styleBrief);
  // Always prepend base; overrides come after to take precedence
  const css = `${baseCss}\n${overrides}`.trim();

  // Cache by hash (optional; useful if you want to persist themes)
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

    // Build stylesheet from Base + minimal AI overrides derived from the combined brief
    const { css } = await generateStylesheet(`${original_prompt}\n\n${prompt}`);

    // Strong output rules: no inline/class/id; start with a single hero figure (round portrait enforced by CSS)
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
- Begin the document with exactly ONE hero figure for the character portrait:
  <figure>
    <img src="{ultra-detailed, full-body portrait of a female dhampir rogue, level 1, black hair, pale skin with faint vampiric features (elongated canines), sleek dark leathers, light travel gear, dual daggers sheathed, agile stance, moody town-backdrop hinted softly (Nightstone ruins), dramatic chiaroscuro lighting, realistic fantasy painting, ultra-detailed textures, no text, no watermark, printed poster composition, centered subject}">
    <figcaption>Character Portrait — Dhampir Rogue (Level 1)</figcaption>
  </figure>
- Use further <img src="{...}"> only if necessary. Never mix real URLs and curly braces in a single src.

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

    // Replace image placeholders AFTER design sanitization
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

    // Angle brackets help Discord render the URL as a clickable link.
    return `${preview}\n\nPDF: ${publicUrl}\n<${publicUrl}>${imagesNote}`;
  } catch (err) {
    await reportError(err, null, "PDF_UNEXPECTED", "FATAL");
    return "[ERROR]: PDF_UNEXPECTED — Could not generate PDF.";
  } finally {
    try { await browser?.close(); } catch {}
  }
}

module.exports = { getPDF };

// pdf.js — refactored v2.1
// Generate a multi-segment HTML document and render it to PDF; returns a short text preview + PDF URL.

const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");

const Context = require("./context");
const { getAIImage, getAI } = require("./aiService");
const { getPlainFromHTML } = require("./helper.js");
const { reportError } = require("./error.js");

/** Create a filesystem-safe, lowercased filename (max 40 chars, no extension). */
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
  const placeholders = [...String(html || "").matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  const map = {};
  const list = [];

  for (const desc of placeholders) {
    if (map[desc]) continue;
    try {
      const url = await getAIImage(desc);
      map[desc] = url;
      list.push(`${desc}  :  ${url}`);
    } catch (err) {
      // Keep placeholder if generation fails, just log as WARN
      await reportError(err, null, "PDF_IMAGE_GEN", "WARN");
    }
  }

  let withImages = html;
  for (const [desc, url] of Object.entries(map)) {
    const esc = desc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\{\\s*${esc}\\s*\\}`, "g");
    withImages = withImages.replace(re, url);
  }
  return { html: withImages, imagelist: list.join("\n") };
}

/* ------------------------- Design Hardening ------------------------- */

/** Remove ALL class/id/style attributes from the generated HTML (global). */
function sanitizeDesign(html) {
  if (!html) return "";
  return String(html).replace(/\s+(class|id|style)=(".*?"|'.*?'|[^\s>]+)/gi, "");
}

/** CSS sanitizer: no @import, no url(...), drop rules with class/id/* selectors; allow only element selectors & @page/@media print. */
function sanitizeCss(css) {
  let s = String(css || "");

  // Block @import and url()
  s = s.replace(/@import[\s\S]*?;?/gi, "");
  s = s.replace(/url\s*\(\s*['"]?[^)]*\)/gi, ""); 

  // Remove !important
  s = s.replace(/!important/gi, "");

  // Remove non-allowed at-rules (keep @page and @media print)
  s = s.replace(/@(?!page|media)[^{]+\{[^}]*\}/gi, "");
  s = s.replace(/@media(?!\s+print)[^{]+\{[^}]*\}/gi, "");

  // Drop rules containing class/id/universal selectors (., #, *).
  s = s.replace(/(^|\})\s*[^@][^{]*[.#\*][^{]*\{[^}]*\}/g, "$1");

  return s.trim();
}

/** Generate a single, global stylesheet via AI based on the prompt; cache by hash. */
async function generateStylesheet(styleBrief = "") {
  const brief = (styleBrief || "").trim();

  const req = new Context();
  await req.add(
    "system",
    "",
    "You generate a single, self-contained CSS stylesheet for A4 printing that styles ONLY element selectors: " +
      "html, body, h1, h2, h3, p, ul, ol, li, table, thead, tbody, tr, th, td, blockquote, figure, figcaption, code, pre, img, hr. " +
      "No classes, no IDs, no @import, no url(). You may use @page and @media print. Prefer CSS variables at :root. Keep it consistent."
  );
  await req.add(
    "user",
    "",
    `Design brief (may be empty):\n${brief}\n\nReturn CSS only, no comments.`
  );

  const rawCss = await getAI(req, 800, "gpt-4o-mini");
  const css = sanitizeCss(rawCss || "");

  // Cache by hash
  const hash = crypto.createHash("sha1").update(css).digest("hex").slice(0, 8);
  const documentsDir = path.join(__dirname, "documents");
  const cssDir = path.join(documentsDir, "css");
  await fs.mkdir(cssDir, { recursive: true });
  const cssPath = path.join(cssDir, `theme-${hash}.css`);
  await fs.writeFile(cssPath, css);

  return { css, cssPath, hash };
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

    // Build global stylesheet from prompt+original
    const { css } = await generateStylesheet(`${original_prompt}\n\n${prompt}`);

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
- Never write placeholders like "to be continued".
- Only append [FINISH] on a new line AFTER the last HTML tag when the document is fully complete.

### Images:
- Use <img src="{...}"> placeholders for images (no inline styles, no classes).
- Do not mix real URLs and curly braces in the same src.

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

    // Lazy require to break circular dependency with tools.js
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

    while (segmentCount < 25) {
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
        "Continue immediately after the last segment. Add only new HTML content. Maintain structure and detail. No inline styles, classes, or ids."
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
    const pdfPath = path.join(documentsDir, `${filename}.pdf`);

    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
    const page = await browser.newPage();
    await page.setContent(styledHtml, { waitUntil: "load" });
    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true
    });

    const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
    const publicUrl = `${base || ""}/documents/${filename}.pdf`;

    const preview = getPlainFromHTML(htmlWithImages, 2000);
    const imagesNote = imagelist ? `\n\n### Images\n${imagelist}` : "";

    return `${preview}\n\nPDF: ${publicUrl || `/documents/${filename}.pdf`}${imagesNote}`;
  } catch (err) {
    await reportError(err, null, "PDF_UNEXPECTED", "FATAL");
    return "[ERROR]: PDF_UNEXPECTED — Could not generate PDF.";
  } finally {
    try {
      await browser?.close();
    } catch {}
  }
}

module.exports = { getPDF };

// pdf.js — refactored v1.4
// Generate a multi-segment HTML document and render it to PDF; returns a short text preview + PDF URL.

const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs/promises");
const Context = require("./context");
const { getAIImage, getAI } = require("./aiService");
const { tools, getToolRegistry } = require("./tools_pdf.js");
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
    const raw = await getAI(req, 50, "gpt-4o");
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

/** Tool entry: build segmented HTML via the model + optional tool calls, then render to PDF. */
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

    const generationContext = new Context(
      "You are a PDF generator that writes final, publish-ready HTML.",
      `### Output:
- Output VALID HTML **inside <body> only** (no <html>/<head> tags).
- Use rich structure: headings, paragraphs, lists, tables; tasteful styling inlined.
- Do **not** include explanations or comments—only HTML.
- No <body> tags in the output.
- Prefer lots of detailed text; write the full content, not outlines.

### Continuation / Segments:
- If long, write in natural segments without artificial endings.
- Never write placeholders like "to be continued".
- Only append [FINISH] on a new line after the last HTML tag when the document is fully complete.

### Images:
- Use <img> with either a real URL (if known) or a curly-brace description as a placeholder, e.g.:
  <img src="{a blue mountain at sunrise}" style="max-width:90%; border:1px solid #ccc;">
- Do not mix real URLs and curly braces in the same src.

### Consistency:
- Use only the most recent user prompt for intent.
- Use prior context only if it contains directly relevant source material to transform or include (e.g., quoted data, previous chapter).`,
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

    let fullHTML = "";
    let persistentToolMessages = [];
    let segmentCount = 0;

    while (segmentCount < 25) {
      const segmentCtx = new Context(
        "You generate the next HTML segment.",
        "",
        tools,
        getToolRegistry(),
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
        "Continue immediately after the last segment. Add only new HTML content. Maintain structure, style, and detail."
      );

      const segmentHTML = await getAIResponse(segmentCtx, 700, 1, "gpt-4o");
      if (!segmentHTML || segmentHTML.length < 100) break;

      const newToolMsgs = segmentCtx.messages.filter((m) => m.role === "tool");
      for (const msg of newToolMsgs) {
        if (!persistentToolMessages.find((m) => m.tool_call_id === msg.tool_call_id)) {
          persistentToolMessages.push(msg);
        }
      }

      if (segmentHTML.includes("[FINISH]")) {
        fullHTML += segmentHTML.replace("[FINISH]", "");
        break;
      } else {
        fullHTML += segmentHTML;
      }
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
  <style>
    @page { size: A4; margin: 2cm; }
    body { font-family: Arial, sans-serif; font-size: 12pt; line-height: 1.6; margin: 0; padding: 0; }
    h1, h2, h3 { margin-top: 1em; page-break-after: avoid; }
    p { text-align: justify; }
    img { max-width: 100%; height: auto; display: block; margin: 10px auto; page-break-inside: avoid; }
    table, tr, td, th { page-break-inside: avoid; }
    .content { padding: 2cm; }
    .page-break { page-break-before: always; }
  </style>
</head>
<body>
  <div class="content">
    ${htmlWithImages}
  </div>
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
      printBackground: true,
      displayHeaderFooter: true,
      footerTemplate:
        `<div style="width:100%; text-align:center; font-size:10pt; color:#888;">Generated by AI</div>`,
      margin: { top: "1cm", right: "1cm", bottom: "1.5cm", left: "1cm" },
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
    try { await browser?.close(); } catch {}
  }
}

module.exports = { getPDF };

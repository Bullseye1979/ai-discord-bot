// pdf.js — v4.2 (SAFE tool-output handling)
// - Kein JSON.parse auf Tool-Outputs (alles als Text weitergereicht)
// - mode ist required (verbatim | transform | from_scratch)
// - Stylesheet via KI (Base + Brief aus History+Prompt); keine inline styles / class / id
// - A4, 1cm Innenabstand; 2-Spalten-Layout default (durch CSS)
// - Bild-Platzhalter {…} werden bei Bedarf mit KI-Bildern ersetzt

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
const IMAGE_SIZE = "1024x1024";
const MAX_IMAGES = 999;
const DISABLE_TOOLS_FOR_PDF = process.env.PDF_DISABLE_TOOLS === "1";

/* ------------------------- Filename helpers ------------------------- */

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

/* ------------------------- Image handling ------------------------- */

function isWeakImageDesc(desc) {
  const s = String(desc || "").trim().toLowerCase();
  if (!s) return true;
  const wc = s.split(/\s+/).length;
  if (wc < 6) return true;
  const generic = [
    "image","picture","photo","portrait","character portrait","logo",
    "icon","banner","header image","cover image","illustration",
    "diagram","chart","graph"
  ];
  if (generic.includes(s)) return true;
  for (const g of generic) {
    if (s === g) return true;
    if ((s.startsWith(g + " of ") || s.startsWith(g + " with ")) && wc <= 6) return true;
  }
  return false;
}

async function enhanceImagePrompt(brief, htmlContext) {
  try {
    const ctx = new Context();
    await ctx.add(
      "system",
      "",
      "You transform a vague image idea into a detailed, concrete, safe prompt for a general image generator.\n" +
      "Rules: 30–90 words. Describe subject, setting, composition, mood, lighting, style/materials. " +
      "No text/watermarks/logos. No brands/copyrighted characters.\n" +
      "Be faithful to provided HTML context; no new proper names. Return the description only."
    );
    await ctx.add("assistant", "", `HTML context (may be truncated):\n${String(htmlContext || "").slice(0, 4000)}`);
    await ctx.add("user", "", `Expand into a rich visual prompt:\n"${brief}"`);
    const out = await getAI(ctx, 200, "gpt-4o-mini");
    return String(out || "").trim() || brief;
  } catch {
    return brief;
  }
}

async function resolveImagePlaceholders(html) {
  const originalMatches = [...String(html || "").matchAll(/\{([^}]+)\}/g)];
  const originals = originalMatches.map((m) => m[1]);
  if (!originals.length) return { html, imagelist: "" };

  const uniqueOriginals = [...new Set(originals)];
  const generationPlan = [];

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

  const limitedPlan = generationPlan.slice(0, MAX_IMAGES);
  const urlMap = new Map();
  const imagelist = [];

  for (const item of limitedPlan) {
    const { original, effective, skipped } = item;
    if (skipped) { imagelist.push(`${original}  :  [SKIPPED — insufficient detail]`); continue; }
    try {
      const url = await getAIImage(effective, IMAGE_SIZE, "dall-e-3");
      if (url) { urlMap.set(original, url); imagelist.push(`${effective}  :  ${url}`); }
      else { imagelist.push(`${effective}  :  [FAILED — no URL returned]`); }
    } catch (err) {
      await reportError(err, null, "PDF_IMAGE_GEN", "WARN");
      imagelist.push(`${effective}  :  [ERROR — generation failed]`);
    }
  }

  let withImages = html;
  for (const [orig, url] of urlMap.entries()) {
    const esc = orig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    withImages = withImages.replace(new RegExp(`\\{\\s*${esc}\\s*\\}`, "g"), url);
  }

  return { html: withImages, imagelist: imagelist.join("\n") };
}

/* ------------------------- Design Hardening ------------------------- */

function sanitizeDesign(html) {
  if (!html) return "";
  return String(html).replace(/\s+(class|id|style)=(".*?"|'.*?'|[^\s>]+)/gi, "");
}

function sanitizeCss(css) {
  let s = String(css || "");
  s = s.replace(/@import[\s\S]*?;?/gi, "");
  s = s.replace(/url\s*\(\s*['"]?[^)]*\)/gi, "");
  s = s.replace(/!important/gi, "");
  s = s.replace(/@(?!page|media)[^{]+\{[^}]*\}/gi, "");
  s = s.replace(/@media(?!\s+print)[^{]+\{[^}]*\}/gi, "");
  s = s.replace(/(^|\})\s*[^@][^{]*[.#\*][^{]*\{[^}]*\}/g, "$1");
  return s.trim();
}

function getBaseMagazineCss() {
  return [
    "@page{size:A4;margin:20mm}",
    "html,body{margin:0;padding:0}",
    // 1 cm Innenabstand:
    "body{font-family:Arial,Helvetica,sans-serif;font-size:12pt;line-height:1.6;color:#111;column-count:2;column-gap:12mm;padding:10mm}",
    "h1{font-size:22pt;margin:0 0 .5rem 0;line-height:1.25;color:#0a66c2;break-after:avoid}",
    "h2{font-size:16pt;margin:1.2rem 0 .5rem 0;line-height:1.25;color:#0a66c2;break-after:avoid}",
    "h3{font-size:13pt;margin:1rem 0 .4rem 0;line-height:1.25;color:#0a66c2;break-after:avoid}",
    "p{margin:.6rem 0;text-align:justify}",
    "ul,ol{margin:.6rem 0 .6rem 1.2rem}",
    "li{margin:.2rem 0}",
    "blockquote{margin:.8rem 0;padding:.6rem 1rem;border-left:3px solid #0a66c2;color:#555;break-inside:avoid}",
    "hr{border:0;border-top:1px solid #ddd;margin:1rem 0;break-after:avoid}",
    "img{max-width:100%;height:auto;display:block;margin:0 auto 8mm;page-break-inside:avoid;border-radius:12px}",
    "figure{break-inside:avoid;page-break-inside:avoid;margin:0 0 8mm 0}",
    "figcaption{text-align:center;font-size:10pt;opacity:.75}",
    "table{border-collapse:collapse;width:100%;break-inside:avoid;margin:.6rem 0}",
    "thead th{background:#0a66c2;color:#fff;padding:.45rem .6rem;text-align:left}",
    "tbody tr:nth-child(even){background:#f6f8fa}",
    "th,td{border:1px solid #d0d7de;padding:.35rem .5rem;vertical-align:top}",
    "code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10pt}",
    "pre{white-space:pre-wrap;background:#f8f8f8;border:1px solid #ddd;padding:.6rem}",
    "figure,table{page-break-inside:avoid}",
  ].join("");
}

/* ------------------------- Style extraction & merge ------------------------- */

async function extractStyleBriefFromHistory(fullMessages, prompt) {
  try {
    const ctx = new Context();
    await ctx.add(
      "system",
      "",
      "You are a style-extraction assistant. Read the conversation (roles preserved) and the current request. " +
      "Output a SHORT style brief (max 120 words) describing typography, colors (esp. headings), layout (columns), images, tables. " +
      "If the current prompt gives explicit overrides, apply them but KEEP other prior preferences intact. Return only the brief."
    );
    const msgs = Array.isArray(fullMessages) ? fullMessages.slice(-40) : [];
    for (const m of msgs) {
      const content = String(m.content || "").slice(0, 2000);
      await ctx.add(m.role || "user", m.name || "", content);
    }
    await ctx.add("user", "", `Current prompt:\n${String(prompt || "").slice(0, 1500)}`);
    const brief = await getAI(ctx, 300, "gpt-4o-mini");
    return String(brief || "").trim();
  } catch (err) {
    await reportError(err, null, "PDF_STYLE_EXTRACTION", "WARN");
    return "";
  }
}

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
    "• The result must be COMPLETE (not a diff/patch).\n" +
    "• Images must fit the page; avoid page breaks in figures.\n" +
    "• Maintain inner text padding of 10mm on body unless explicitly overridden."
  );
  await req.add("assistant", "", `### DEFAULT BASE CSS\n${baseCss}`);
  await req.add("user", "", `Style brief:\n${String(styleBrief || "").trim()}\n\nReturn the FINAL COMPLETE CSS only.`);
  const raw = await getAI(req, 1000, "gpt-4o-mini");
  return sanitizeCss(raw || "");
}

async function generateStylesheetFromHistory(fullMessages, prompt) {
  const baseCss = getBaseMagazineCss();
  const brief = await extractStyleBriefFromHistory(fullMessages, prompt);
  const finalCss = await mergeBaseCssWithBrief(baseCss, brief);
  const css = (finalCss && finalCss.length > 200) ? finalCss : baseCss;

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
  if (base) return `${base}${urlPath.startsWith("/") ? "" : "/"}${urlPath}`;
  return urlPath;
}

/* ------------------------- Main Entry ------------------------- */

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
    const modeRaw = String(args.mode || "").toLowerCase();

    if (!prompt || !original_prompt || !user_id) {
      return "[ERROR]: PDF_INPUT — Missing 'prompt', 'original_prompt' or 'user_id'.";
    }
    const allowed = new Set(["verbatim","transform","from_scratch"]);
    if (!allowed.has(modeRaw)) {
      return "[ERROR]: PDF_INPUT — Missing or invalid 'mode' (expected verbatim|transform|from_scratch).";
    }
    const mode = modeRaw;

    // 1) Stylesheet aus GANZEM Verlauf + Prompt
    const fullMessages = Array.isArray(context?.messages) ? context.messages : [];
    const { css } = await generateStylesheetFromHistory(fullMessages, `${original_prompt}\n\n${prompt}`);

    // 2) Tools bereitstellen (ab erstem Turn)
    let toolSpecs = [];
    let toolRegistry = {};
    if (!DISABLE_TOOLS_FOR_PDF) {
      const { getToolRegistry } = require("./tools.js");
      const allowTools = ["getHistory","getWebpage","getImage","getGoogle","getYoutube","getLocation","getImageDescription"];
      const reg = getToolRegistry(allowTools);
      toolSpecs = reg.tools;
      toolRegistry = reg.registry;
    }

    // 3) Generator-Kontext
    const generationContext = new Context(
      "You are a PDF generator that writes final, publish-ready HTML.",
      `### Output (STRICT):
- Output VALID HTML **inside <body> only** (no <html>/<head> tags).
- **NO inline styles, NO class=, NO id=** anywhere.
- Use only semantic tags: h1–h3, p, ul/ol/li, table/thead/tbody/tr/th/td, blockquote, figure, figcaption, img, hr, br, code, pre.
- Prefer rich, complete content (not outlines).

### Content Mode (provided by caller):
- Mode: ${mode}.
- If 'verbatim': include the identified text EXACTLY (unchanged).
- If 'transform': apply the requested transformation to the identified source text, then include.
- If 'from_scratch': write new content guided by the conversation’s preferences (typography/colors).

### Data & Tools:
- If the user asks to include existing summaries, call getHistory.
- If the user asks for web content or images, call the appropriate tool(s).
- Do not invent data that was requested from tools.

### Images:
- If using images, <img src="{...}"> placeholders only (no inline styles).
- Placeholder descriptions must be concrete (≥ 6 words).
- Figures should avoid page breaks; images must scale to fit.`,
      toolSpecs,
      toolRegistry,
      null,
      { skipInitialSummaries: true, persistToDB: false }
    );

    generationContext.messages = [...fullMessages];
    await generationContext.add("user", "", `Original User Prompt:\n${original_prompt}\n\nSpecific instructions:\n${prompt}\n\nRemember mode=${mode}.`);

    // 4) Segmente generieren (Tool-Outputs nur als Text puffern, KEIN JSON.parse)
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

      // bereits bekannte Tool-Ergebnisse bereitstellen (als reiner Text)
      if (persistentToolMessages.length > 0) {
        const toolBlock = persistentToolMessages.map((m) => String(m.content ?? "")).join("\n\n");
        await segmentCtx.add("assistant", "", "### Tool Results (context)\n\n" + toolBlock);
      }
      if (segmentCount > 0) {
        await segmentCtx.add("assistant", "", "### Previously Generated HTML\n\n" + fullHTML);
      }
      await segmentCtx.add(
        "user",
        "",
        "Continue immediately after the last segment. Add only new FINAL HTML content. Maintain structure and detail. No inline styles, classes, or ids."
      );

      const segmentHTML = await getAIResponse(segmentCtx, 700, 1, "gpt-4o");
      if (!segmentHTML || segmentHTML.length < 100) break;

      // NEU: Tool-Messages nur TEXTUELL übernehmen (kein JSON.parse)
      const newToolMsgs = segmentCtx.messages.filter((m) => m.role === "tool");
      for (const msg of newToolMsgs) {
        const already = persistentToolMessages.find((m) => m.tool_call_id === msg.tool_call_id);
        if (!already) {
          persistentToolMessages.push({
            role: "tool",
            tool_call_id: msg.tool_call_id,
            content: String(msg.content ?? "")
          });
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

    // 5) Bilder ersetzen (falls generiert)
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

    // 6) Rendern
    const documentsDir = path.join(__dirname, "documents");
    await fs.mkdir(documentsDir, { recursive: true });

    const suggested = await suggestFilename(original_prompt, prompt);
    const filename = normalizeFilename(suggested || "document");
    const publicPath = `/documents/${filename}.pdf`;
    const pdfPath = path.join(documentsDir, `${filename}.pdf`);

    const browserOpts = { headless: "new", args: ["--no-sandbox"] };
    browser = await puppeteer.launch(browserOpts);
    const page = await browser.newPage();
    await page.setContent(styledHtml, { waitUntil: "load" });
    await page.pdf({ path: pdfPath, format: "A4", printBackground: true });

    const publicUrl = ensureAbsoluteUrl(publicPath);
    const preview = getPlainFromHTML(htmlWithImages, 2000);
    const imagesNote = imagelist ? `\n\n### Images\n${imagelist}` : "";

    return `${preview}\n\nPDF: ${publicUrl}\n<${publicUrl}>${imagesNote}`;
  } catch (err) {
    await reportError(err, null, "PDF_UNEXPECTED", "FATAL");
    return "[ERROR]: PDF_UNEXPECTED — Could not generate PDF.";
  } finally {
    try { await browser?.close(); } catch {}
  }
}

module.exports = { getPDF };

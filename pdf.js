// pdf.js — stable v4.6
// Render provided HTML (+ optional CSS) into a PDF AND save a same-named .html file.
// Returns absolute links to PDF and HTML + final CSS + plain text (no HTML).
// Enforces non-overridable print rules: A4, 20mm page margin, 10mm inner padding, avoid split of tables/figures/etc.
// Robust args parsing: accepts object, JSON string, or fenced blocks (```html / ```css). Adds debug logs.

const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs/promises");
const { reportError } = require("./error.js");
const { getPlainFromHTML } = require("./helper.js");

/* ------------------------- Helpers ------------------------- */

/** FS-safe, lowercased filename (max 40 chars, no extension). */
function normalizeFilename(s, fallback = "") {
  const base =
    String(s || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  return base || fallback || `document-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
}

/** Build absolute URL from PUBLIC_BASE_URL (or BASE_URL) + path. */
function ensureAbsoluteUrl(urlPath) {
  const base = (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "").replace(/\/$/, "");
  if (/^https?:\/\//i.test(urlPath)) return urlPath;
  if (base) return `${base}${urlPath.startsWith("/") ? "" : "/"}${urlPath}`;
  return urlPath; // relative fallback
}

/** Extract body innerHTML if a full HTML document was supplied. */
function extractBody(html) {
  const s = String(html || "");
  const m = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (m) return m[1];
  return s;
}

/** Enforced CSS that cannot be overridden (element selectors + !important, last in cascade). */
function enforcedCss() {
  return [
    // Page & margins (A4 + outer 20mm)
    "@page{size:A4;margin:20mm !important}",
    "html,body{margin:0 !important;padding:0 !important}",
    // Inner text padding 10mm
    "body{padding:10mm !important}",
    // Avoid splitting key elements across pages
    "table, thead, tbody, tr, th, td, figure, img, pre, blockquote, .box, .card{page-break-inside:avoid !important; break-inside:avoid !important}",
    "h1,h2,h3{break-after:avoid !important; page-break-after:auto !important}",
    // Image fit
    "img{max-width:100% !important; height:auto !important; display:block !important}",
  ].join("");
}

/** Wrap body HTML + CSS into a printable full HTML document. */
function buildPrintableHtml(bodyHtml, userCss = "", title = "Document") {
  // User CSS first, enforced CSS last (with !important) so es gewinnt die Kaskade.
  const cssFinal = `${String(userCss || "")}\n${enforcedCss()}`;
  const safeTitle = String(title || "Document").slice(0, 140);
  const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${safeTitle}</title>
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>${cssFinal}</style>
</head>
<body>
${bodyHtml || ""}
</body>
</html>`;
  return { fullHtml, cssFinal };
}

/* ------------------------- Argument Parsing ------------------------- */

/** Trim code fences from a block. */
function stripFences(s) {
  if (typeof s !== "string") return s;
  let t = s.trim();
  // remove generic ```
  if (/^```/.test(t)) {
    t = t.replace(/^```(?:html|css|md|json)?\s*/i, "").replace(/```$/i, "");
  }
  return t.trim();
}

/** Extract fenced blocks for html/css if present */
function parseFencedBlocks(raw) {
  const str = String(raw || "");
  const htmlMatch = str.match(/```html([\s\S]*?)```/i);
  const cssMatch  = str.match(/```css([\s\S]*?)```/i);

  const html = htmlMatch ? stripFences(htmlMatch[0].replace(/^```html/i, "```")) : null;
  const css  = cssMatch  ? stripFences(cssMatch[0].replace(/^```css/i,  "```")) : null;

  return { html, css };
}

/** Try to parse arguments: object → ok; JSON string → ok; fenced blocks → ok; else raw string treated as HTML. */
function safeParseToolArgs(toolFunction) {
  const raw = toolFunction?.arguments;

  // Debug dump
  try {
    console.log("[PDF_ARGS_PARSE][raw typeof]", typeof raw);
    if (typeof raw === "string") {
      console.log("[PDF_ARGS_PARSE][raw len]", raw.length);
      console.log("[PDF_ARGS_PARSE][raw preview]", raw.slice(0, 300));
    } else {
      console.log("[PDF_ARGS_PARSE][raw object keys]", raw && Object.keys(raw));
    }
  } catch {}

  if (!raw) return {};

  // If already object, use directly
  if (typeof raw === "object") return raw;

  // If string: first try strict JSON
  if (typeof raw === "string") {
    try {
      const obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? obj : {};
    } catch (e1) {
      try { console.log("[PDF_DEBUG] ARGS strict JSON failed:", e1.message); } catch {}
      // Try fenced blocks
      const { html, css } = parseFencedBlocks(raw);
      if (html || css) {
        return { html: html || "", css: css || "" };
      }

      // Try strip ```json fences and parse
      const s2 = raw.replace(/^```(?:json|md)?\s*/i, "").replace(/```$/i, "");
      try {
        const obj2 = JSON.parse(s2);
        return obj2 && typeof obj2 === "object" ? obj2 : {};
      } catch (e2) {
        try { console.log("[PDF_DEBUG] ARGS fenced JSON failed:", e2.message); } catch {}
        // Last resort: treat the entire string as HTML
        return { html: raw, css: "" };
      }
    }
  }

  return {};
}

/* ------------------------- Main Tool Entry ------------------------- */

async function getPDF(toolFunction /*, context, getAIResponse */) {
  let browser = null;
  try {
    // Parse args robustly
    let args;
    try {
      args = safeParseToolArgs(toolFunction);
    } catch (e) {
      await reportError(e, null, "PDF_ARGS_PARSE");
      throw e;
    }

    const htmlIn = String(args.html || "").trim();
    const cssIn  = String(args.css  || "");
    const title  = String(args.title || "");
    const filenameArg = String(args.filename || "");
    const userId = String(args.user_id || ""); // optional

    if (!htmlIn) {
      return "[ERROR]: PDF_INPUT — Missing 'html' content.";
    }

    // Prepare content
    const bodyHtml = extractBody(htmlIn);
    const { fullHtml, cssFinal } = buildPrintableHtml(bodyHtml, cssIn, title || "Document");

    // Paths
    const documentsDir = path.join(__dirname, "documents");
    await fs.mkdir(documentsDir, { recursive: true });

    const filename = normalizeFilename(filenameArg, "");
    const baseName = filename || normalizeFilename(title, "") || normalizeFilename("document");
    const pdfPath  = path.join(documentsDir, `${baseName}.pdf`);
    const htmlPath = path.join(documentsDir, `${baseName}.html`);

    // Write standalone HTML file (for direct viewing)
    await fs.writeFile(htmlPath, fullHtml, "utf8");

    // Render PDF with Puppeteer
    const launchOpts = { headless: "new", args: ["--no-sandbox"] };
    browser = await puppeteer.launch(launchOpts);
    const page = await browser.newPage();

    // Load our local HTML and wait for network for images
    await page.setContent(fullHtml, { waitUntil: "networkidle0", timeout: 120000 });

    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      // We enforce margins via @page; use zero here to avoid double margins.
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });

    const publicPdf  = ensureAbsoluteUrl(`/documents/${path.basename(pdfPath)}`);
    const publicHtml = ensureAbsoluteUrl(`/documents/${path.basename(htmlPath)}`);

    // Build a clean text preview from the BODY content (for the return payload)
    const plainText = getPlainFromHTML(bodyHtml, 20000); // großzügig, du filterst später

    // Return the 4 gewünschten Felder als gut verwertbarer Plaintext-Block:
    // (Keine JSON-Zwänge; leicht im Bot zu parsen)
    return [
      `PDF: ${publicPdf}`,
      `HTML: ${publicHtml}`,
      "CSS:",
      "```css",
      cssFinal,
      "```",
      "TEXT:",
      plainText
    ].join("\n");
  } catch (err) {
    await reportError(err, null, "PDF_UNEXPECTED", "FATAL");
    return "[ERROR]: PDF_UNEXPECTED — Could not generate PDF/HTML.";
  } finally {
    try { await browser?.close(); } catch {}
  }
}

module.exports = { getPDF };

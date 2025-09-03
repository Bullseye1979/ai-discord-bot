// pdf.js — stable renderer v1.0
// Input: { html, css?, filename?, title?, user_id? } via tool args
// Output: human-readable string incl. public PDF URL, plain-text preview, and the effective CSS.
// Guarantees (hard, non-overridable by user CSS): A4, 10mm margins, no table/figure/blockquote/image splits.

const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs/promises");
const { reportError } = require("./error.js");
const { getPlainFromHTML } = require("./helper.js");

/* ------------------------- Utilities ------------------------- */

/** Strip ``` fences, BOM, normalize quotes/newlines. */
function cleanseArgString(s) {
  if (typeof s !== "string") return "";
  let t = s.trim();
  // remove code fences
  t = t.replace(/^```(?:json)?\s*/i, "");
  t = t.replace(/\s*```$/i, "");
  // remove BOM
  t = t.replace(/^\uFEFF/, "");
  // normalize smart quotes
  t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  // normalize newlines
  t = t.replace(/\r\n/g, "\n");
  return t;
}

/** Parse tool args safely. Never throw. On failure, return { ok:false, error, raw }. */
function safeParseToolArgs(toolFunction) {
  try {
    const a = toolFunction?.arguments;
    if (a && typeof a === "object") return { ok: true, args: a };
    const raw = cleanseArgString(String(a || ""));
    try {
      const parsed = JSON.parse(raw);
      return { ok: true, args: parsed };
    } catch (e) {
      // try to repair trailing commas
      const repaired = raw.replace(/,\s*([}\]])/g, "$1");
      try {
        const parsed2 = JSON.parse(repaired);
        return { ok: true, args: parsed2 };
      } catch (e2) {
        reportError(e2, null, "PDF_ARGS_PARSE", "ERROR", { rawPreview: raw.slice(0, 500) });
        return { ok: false, error: "Failed to parse getPDF tool arguments", raw };
      }
    }
  } catch (e) {
    reportError(e, null, "PDF_ARGS_PARSE", "ERROR");
    return { ok: false, error: "Failed to parse getPDF tool arguments", raw: "" };
  }
}

/** Make filesystem-safe, lowercased filename (max 40 chars, no extension). */
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

/** Extract only the <body> content if full HTML given; else return as-is. */
function extractBody(html) {
  if (!html) return "";
  const s = String(html);
  const bodyMatch = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) return bodyMatch[1];
  // If there's an <html> but no explicit <body>, take everything between <html>…</html> as a fallback
  const htmlMatch = s.match(/<html[^>]*>([\s\S]*?)<\/html>/i);
  if (htmlMatch) return htmlMatch[1];
  return s;
}

/** Remove <script> tags completely for safety. */
function stripScripts(html) {
  if (!html) return "";
  return String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}

/** Ensure absolute public URL using PUBLIC_BASE_URL / BASE_URL. */
function ensureAbsoluteUrl(urlPath) {
  const base = (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "").replace(/\/$/, "");
  if (/^https?:\/\//i.test(urlPath)) return urlPath;
  if (base) {
    return `${base}${urlPath.startsWith("/") ? "" : "/"}${urlPath}`;
  }
  return urlPath; // relative fallback
}

/* ------------------------- Hard CSS (non-overridable) ------------------------- */
/**
 * Diese Regeln sollen NICHT vom User-Stylesheet überschrieben werden:
 * - A4 Format, 10mm Ränder
 * - Keine Splits in Tabellen, Figures, Blockquotes, Bildern
 * - Grundlegende Bild-Skalierung (fit)
 *
 * Taktiken:
 *  - Sehr hohe Spezifität (html body …)
 *  - !important
 *  - eigenes <style id="hard-rules"> vor dem User-CSS
 */
function hardCss() {
  return [
    "@page{size:A4;margin:10mm !important}",
    "html, body{margin:0 !important;padding:0 !important}",
    // Basispadding im Body (zusätzlich zum @page-Margin – hilft innerer Abstand)
    "html body{padding:0 !important}",
    // Splits verhindern
    "html body table, html body tr, html body td, html body th, html body thead, html body tbody{page-break-inside: avoid !important; break-inside: avoid !important}",
    "html body figure, html body blockquote, html body pre, html body code{page-break-inside: avoid !important; break-inside: avoid !important}",
    "html body img{max-width:100% !important;height:auto !important;display:block !important;page-break-inside: avoid !important; break-inside: avoid !important}",
  ].join("");
}

/* ------------------------- HTML Document Wrapper ------------------------- */

function buildHtmlDocument(bodyHtml, userCss, title = "Document") {
  const hard = hardCss();
  const safeCss = String(userCss || "");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title || "Document")}</title>
  <!-- Hard non-overridable rules -->
  <style id="hard-rules">
  ${hard}
  </style>
  <!-- User stylesheet (may override most but not the hard rules above) -->
  <style id="user-styles">
  ${safeCss}
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/** Minimal HTML escaper for <title>. */
function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* ------------------------- Main Tool Entry ------------------------- */

async function getPDF(toolFunction /*, context, getAIResponse */) {
  let browser = null;
  try {
    // Robust arg parsing; never throw
    const parsed = safeParseToolArgs(toolFunction);
    if (!parsed.ok) {
      return JSON.stringify({
        ok: false,
        error: parsed.error,
        hint: "Bitte die Tool-Argumente als gültiges JSON senden (html/css/filename/title als Strings).",
      });
    }

    const args = parsed.args || {};
    const htmlInput = String(args.html || "");
    const cssInput = String(args.css || ""); // optional
    const filenameInput = String(args.filename || "").trim();
    const title = String(args.title || "").trim();

    if (!htmlInput) {
      return JSON.stringify({
        ok: false,
        error: "Missing required 'html' input.",
        hint: "Sende mindestens { html: \"...\" }.",
      });
    }

    const bodyOnly = stripScripts(extractBody(htmlInput));

    const documentsDir = path.join(__dirname, "documents");
    await fs.mkdir(documentsDir, { recursive: true });

    const filename = normalizeFilename(filenameInput || (title || "document"));
    const pdfPath = path.join(documentsDir, `${filename}.pdf`);
    const publicPath = `/documents/${filename}.pdf`;

    const htmlDoc = buildHtmlDocument(bodyOnly, cssInput, title);

    // Render
    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
    const page = await browser.newPage();

    await page.setContent(htmlDoc, { waitUntil: "load" });

    // Wait for all images to settle (prevents broken images)
    try {
      await page.evaluate(() =>
        Promise.all(
          Array.from(document.images).map((img) => {
            if (img.complete) return Promise.resolve();
            return new Promise((res) => {
              img.addEventListener("load", res, { once: true });
              img.addEventListener("error", res, { once: true });
            });
          })
        )
      );
    } catch {
      // ignore
    }

    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      // @page margin is authoritative; we don't set margin here to avoid conflicts
    });

    const publicUrl = ensureAbsoluteUrl(publicPath);

    // Plain-text preview (limit inside helper), to help the chat output
    const preview = getPlainFromHTML(bodyOnly, 2000);

    // Returning a human-friendly block; also angle-bracket URL for clickable embed in manchen Clients
    return [
      `PDF: ${publicUrl}`,
      `<${publicUrl}>`,
      ``,
      `--- Plaintext Preview ---`,
      preview,
      ``,
      `--- CSS Used ---`,
      "```css",
      cssInput || "/* (no user CSS provided) */",
      "```",
    ].join("\n");
  } catch (err) {
    await reportError(err, null, "PDF_UNEXPECTED", "ERROR");
    // Never throw; always return a tool string
    return JSON.stringify({
      ok: false,
      error: "PDF_UNEXPECTED — Could not generate PDF.",
      details: err?.message || String(err),
    });
  } finally {
    try {
      await browser?.close();
    } catch {}
  }
}

module.exports = { getPDF };

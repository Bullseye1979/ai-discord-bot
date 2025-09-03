// pdf.js — v5.0 (Simple HTML+CSS -> PDF renderer)
// Eingabe: { html, css?, filename?, title?, user_id? }
// Ausgabe: Plaintext-Preview + PDF-Link + verwendetes Stylesheet
//
// - Kein KI-Aufruf, keine Tool-Abhängigkeiten.
// - A4, printBackground; PUBLIC_BASE_URL zur Link-Erzeugung.
// - Falls kein CSS geliefert, wird ein defensives Default-Stylesheet genutzt (inkl. 1cm Innenabstand).

const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs/promises");

const { reportError } = require("./error.js");
const { getPlainFromHTML } = require("./helper.js");

/* ------------------------- Helpers ------------------------- */

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

function ensureAbsoluteUrl(urlPath) {
  const base = (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "").replace(/\/$/, "");
  if (/^https?:\/\//i.test(urlPath)) return urlPath;
  if (base) return `${base}${urlPath.startsWith("/") ? "" : "/"}${urlPath}`;
  return urlPath; // fallback: relative
}

/** Robust parse for tool function arguments (ohne harte JSON.parse-Crashes). */
function safeParseArgs(argInput) {
  try {
    if (!argInput) return {};
    if (typeof argInput === "object") return argInput;
    const s = String(argInput).trim();
    if (!s) return {};
    return JSON.parse(s);
  } catch {
    return "__ARGS_PARSE_ERROR__";
  }
}

/** Minimal Default-CSS (drucktauglich, 1cm padding, 2 Spalten, farbige Tabellen). */
function getDefaultCss() {
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
  ].join("");
}

/** Entnimmt nur den <body>-Inhalt, wenn kompletter HTML geliefert wurde. */
function extractBody(html) {
  const s = String(html || "");
  const m = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (m) return m[1];
  // Falls kompletter HTML inkl. <head> geliefert wurde und kein <body> vorhanden ist,
  // nehmen wir den gesamten Inhalt als body:
  const hasHtml = /<html[\s>]/i.test(s) || /<!doctype/i.test(s) || /<head[\s>]/i.test(s);
  return hasHtml ? s : s; // s wird als Body eingefügt
}

/* ------------------------- Main Tool Entry ------------------------- */

async function getPDF(toolFunction /*, context, getAIResponse */) {
  let browser = null;
  try {
    const args = safeParseArgs(toolFunction?.arguments);
    if (args === "__ARGS_PARSE_ERROR__") {
      await reportError(new Error("Failed to parse getPDF tool arguments"), null, "PDF_ARGS_PARSE", "WARN");
      return "[ERROR]: PDF_INPUT — Could not parse tool arguments (invalid JSON).";
    }

    const rawHtml = String(args.html || "").trim();
    const cssInput = String(args.css || "").trim();
    const filenameArg = String(args.filename || "").trim();
    const title = String(args.title || "").trim();
    // user_id optional; derzeit nur für Logging denkbar:
    // const user_id = String(args.user_id || "").trim();

    if (!rawHtml) {
      return "[ERROR]: PDF_INPUT — Missing 'html' content.";
    }

    const bodyHtml = extractBody(rawHtml);
    const css = cssInput || getDefaultCss();

    // Komplettes Dokument zusammensetzen
    const docTitle = title || "Document";
    const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(docTitle)}</title>
  <style>${css}</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;

    // Dateien & Pfade
    const documentsDir = path.join(__dirname, "documents");
    await fs.mkdir(documentsDir, { recursive: true });

    const filename = normalizeFilename(filenameArg || docTitle || "document");
    const publicPath = `/documents/${filename}.pdf`;
    const pdfPath = path.join(documentsDir, `${filename}.pdf`);

    // Rendern
    const browserOpts = { headless: "new", args: ["--no-sandbox"] };
    browser = await puppeteer.launch(browserOpts);
    const page = await browser.newPage();
    await page.setContent(fullHtml, { waitUntil: "load" });
    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
    });

    const publicUrl = ensureAbsoluteUrl(publicPath);

    // Reintext-Preview (aus Body)
    const preview = getPlainFromHTML(bodyHtml, 2000);

    // Rückgabe als gut konsumierbarer Textblock
    return [
      `PDF: ${publicUrl}`,
      `<${publicUrl}>`,
      "",
      "### Plaintext Preview",
      preview,
      "",
      "### Stylesheet Used",
      css
    ].join("\n");

  } catch (err) {
    await reportError(err, null, "PDF_UNEXPECTED", "FATAL");
    return "[ERROR]: PDF_UNEXPECTED — Could not generate PDF.";
  } finally {
    try { await browser?.close(); } catch {}
  }
}

/** Einfache HTML-Escapes für <title>. */
function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = { getPDF };

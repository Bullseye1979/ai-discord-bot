// pdf.js — v5.1 (HTML+CSS -> PDF, ultra-toleranter Argument-Parser)
// Eingabe (Tool-Args): { html (req), css?, filename?, title?, user_id? }
// Ausgabe: Textblock mit PDF-Link, Plaintext-Preview, Stylesheet
//
// - Keine KI-Aufrufe; nur Rendering mit Puppeteer
// - PUBLIC_BASE_URL wird für den Link verwendet
// - 1cm Innenabstand im Default-CSS
// - Hartes Ziel: NIE werfen — immer eine Tool-Antwort zurückgeben!

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
  return urlPath; // relative fallback
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
  const hasHtmlLike = /<html[\s>]/i.test(s) || /<!doctype/i.test(s) || /<head[\s>]/i.test(s);
  return hasHtmlLike ? s : s;
}

/** Sehr toleranter Argument-Parser: wirfst NIE. */
function safeParseArgsLoose(argInput) {
  try {
    if (!argInput) return {};
    if (typeof argInput === "object") return argInput;

    let s = String(argInput).trim();
    if (!s) return {};

    // 1) Normaler JSON.parse
    try { return JSON.parse(s); } catch {}

    // 2) JSON Substring zwischen erstem { und letztem }
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      const sub = s.slice(first, last + 1);
      try { return JSON.parse(sub); } catch {}
    }

    // 3) Reparaturen: Smart Quotes -> "
    s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

    // 4) Einfache Quotes zu doppelten (nur wenn plausibel):
    // Achtung: sehr grob — aber besser als crashen. Wir versuchen es nur,
    // wenn der String wie ein Objekt aussieht und doppelte Quotes rar sind.
    const looksLikeObject = s.trim().startsWith("{") && s.trim().endsWith("}");
    if (looksLikeObject && (s.match(/"/g) || []).length < 2) {
      const s2 = s.replace(/'/g, '"');
      try { return JSON.parse(s2); } catch {}
    }

    // 5) Querystring / key=value-Zeilen
    if (/^[a-z0-9_\-]+\s*=/i.test(s) || s.includes("&")) {
      const obj = {};
      const pairs = s.split(/[&\n]/);
      for (const p of pairs) {
        const [k, v] = p.split("=").map(x => (x || "").trim());
        if (k) obj[k] = decodeURIComponent((v || "").replace(/\+/g, " "));
      }
      if (Object.keys(obj).length > 0) return obj;
    }

    // 6) Wenn wie HTML aussieht: interpretieren als { html: s }
    if (/[<][a-z!]/i.test(s)) return { html: s };

    // 7) Fallback: als „html“ annehmen, wenn viel Markup drin ist
    if (s.length > 200) return { html: s };

    // 8) Letzter Fallback: leeres Objekt
    return {};
  } catch {
    return {};
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

/* ------------------------- Main Tool Entry ------------------------- */

async function getPDF(toolFunction /*, context, getAIResponse */) {
  let browser = null;
  try {
    const args = safeParseArgsLoose(toolFunction?.arguments);

    const rawHtml = String(args.html || "").trim();
    const cssInput = String(args.css || "").trim();
    const filenameArg = String(args.filename || "").trim();
    const title = String(args.title || "").trim();
    // const user_id = String(args.user_id || "").trim(); // optional

    if (!rawHtml) {
      // NIE werfen → immer eine Tool-Antwort:
      return "[ERROR]: PDF_INPUT — Missing 'html' content.";
    }

    const bodyHtml = extractBody(rawHtml);
    const css = cssInput || getDefaultCss();

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
    // NIE weiterwerfen → Tool-Antwort zurückgeben
    await reportError(err, null, "PDF_UNEXPECTED", "FATAL");
    return "[ERROR]: PDF_UNEXPECTED — Could not generate PDF.";
  } finally {
    try { await browser?.close(); } catch {}
  }
}

module.exports = { getPDF };

// pdf.js — v5.3 (HTML+CSS -> PDF, HARDENED: A4 + 1cm margins + no split tables/boxes)
//
// Eingabe (Tool-Args): { html (req), css?, filename?, title?, user_id? }
// Ausgabe: Textblock mit PDF-Link, Plaintext-Preview, Stylesheet (das verwendete)
//
// Wichtige Garantien (nicht überschreibbar durch fremde Styles):
// • Fixes Format A4 (Puppeteer pdf option)
// • 1 cm Ränder (Puppeteer pdf option)
// • Tabellen/„Boxen“ werden nicht über Seiten umbrochen (hartes @media print + !important)
//   (table/thead/tbody/tr/th/td, figure/img/svg, blockquote, pre/code, dl/ul/ol,
//    sowie section/article/aside/header/footer/main)
//
// Hinweis: Wir injizieren IMMER einen Hardening-Styleblock ans Ende des <head>,
// egal ob CSS als Argument oder inline im gelieferten HTML kam.

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

/** Default CSS (neutral). */
function getDefaultCss() {
  return [
    "@page{size:A4;margin:20mm}",
    "html,body{margin:0;padding:0}",
    "body{font-family:Arial,Helvetica,sans-serif;font-size:12pt;line-height:1.6;color:#111;padding:10mm}", // 1cm Innenabstand
    "h1{font-size:22pt;margin:0 0 .5rem 0;line-height:1.25;color:#0a66c2;break-after:avoid}",
    "h2{font-size:16pt;margin:1.2rem 0 .5rem 0;line-height:1.25;color:#0a66c2;break-after:avoid}",
    "h3{font-size:13pt;margin:1rem 0 .4rem 0;line-height:1.25;color:#0a66c2;break-after:avoid}",
    "p{margin:.6rem 0;text-align:justify}",
    "ul,ol{margin:.6rem 0 .6rem 1.2rem}",
    "li{margin:.2rem 0}",
    "blockquote{margin:.8rem 0;padding:.6rem 1rem;border-left:3px solid #0a66c2;color:#555;break-inside:avoid}",
    "hr{border:0;border-top:1px solid #ddd;margin:1rem 0;break-after:avoid}",
    "img{max-width:100%;height:auto;display:block;margin:0 auto 8mm;border-radius:8px}",
    "figure{break-inside:avoid;margin:0 0 8mm 0}",
    "figcaption{text-align:center;font-size:10pt;opacity:.75}",
    "table{border-collapse:collapse;width:100%;margin:.6rem 0}",
    "thead th{background:#0a66c2;color:#fff;padding:.45rem .6rem;text-align:left}",
    "tbody tr:nth-child(even){background:#f6f8fa}",
    "th,td{border:1px solid #d0d7de;padding:.35rem .5rem;vertical-align:top}",
    "code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10pt}",
    "pre{white-space:pre-wrap;background:#f8f8f8;border:1px solid #ddd;padding:.6rem}",
  ].join("");
}

/** HARDENING-CSS (nicht überschreibbar in der Praxis, da wir es zuletzt injizieren + !important). */
const HARDENING_CSS = `
@media print {
  /* A4 + 1cm – als CSS deklariert, aber final durch Puppeteer-PDF-Optionen garantiert */
  @page { size: A4; margin: 10mm !important; }

  /* Verhindere globale Ränder/Paddings, die @page in Frage stellen könnten */
  html, body { margin: 0 !important; padding: 0 !important; }

  /* Verhindere Splits innerhalb kritischer Blöcke */
  table, thead, tbody, tr, th, td,
  figure, img, svg,
  blockquote,
  pre, code,
  dl, ul, ol {
    break-inside: avoid !important;
    page-break-inside: avoid !important;
  }

  /* Versuche semantische „Boxen“ zusammen zu halten */
  section, article, aside, header, footer, main {
    break-inside: avoid !important;
    page-break-inside: avoid !important;
  }
}
`.trim();

/** Inline-CSS aus <head> extrahieren */
function extractInlineCssFromFullHtml(html) {
  try {
    const s = String(html || "");
    const headMatch = s.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
    if (!headMatch) return "";
    const head = headMatch[1];
    const styles = [...head.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1].trim());
    return styles.join("\n\n").trim();
  } catch { return ""; }
}

/** Body-Inhalt aus HTML extrahieren */
function extractBody(html) {
  const s = String(html || "");
  const m = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (m) return m[1];
  return s;
}

/** Ultra-toleranter Argument-Parser */
function safeParseArgsLoose(argInput) {
  try {
    if (!argInput) return {};
    if (typeof argInput === "object") return argInput;
    let s = String(argInput).trim();
    if (!s) return {};

    try { return JSON.parse(s); } catch {}

    const first = s.indexOf("{"), last = s.lastIndexOf("}");
    if (first !== -1 && last > first) {
      try { return JSON.parse(s.slice(first, last + 1)); } catch {}
    }

    s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    const looksLikeObj = s.trim().startsWith("{") && s.trim().endsWith("}");
    if (looksLikeObj) {
      try { return JSON.parse(s.replace(/'/g, '"')); } catch {}
    }

    if (/^[a-z0-9_\-]+\s*=/i.test(s) || s.includes("&")) {
      const obj = {};
      for (const p of s.split(/[&\n]/)) {
        const [k, v] = p.split("=").map(x => (x || "").trim());
        if (k) obj[k] = decodeURIComponent((v || "").replace(/\+/g, " "));
      }
      if (Object.keys(obj).length > 0) return obj;
    }

    if (/[<][a-z!]/i.test(s)) return { html: s };
    if (s.length > 200) return { html: s };
    return {};
  } catch { return {}; }
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Hardening-CSS am Ende des <head> injizieren; wenn kein <head> existiert, anlegen. */
function injectHardeningCss(html, hardCss) {
  const s = String(html || "");
  if (/<head[\s>]/i.test(s)) {
    // direkt vor </head> einfügen
    return s.replace(/<\/head>/i, `<style id="__pdf_hardening__">\n${hardCss}\n</style>\n</head>`);
  }
  // kein <head>: komplettes HTML-Gerüst bauen
  const bodyContent = extractBody(s);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style id="__pdf_hardening__">${hardCss}</style>
</head>
<body>
${bodyContent}
</body>
</html>`;
}

/* ------------------------- Main Tool Entry ------------------------- */

async function getPDF(toolFunction) {
  let browser = null;
  try {
    const args = safeParseArgsLoose(toolFunction?.arguments);

    const rawHtml = String(args.html || "").trim();
    const cssInput = String(args.css || "").trim();
    const filenameArg = String(args.filename || "").trim();
    const title = String(args.title || "").trim();

    if (!rawHtml) return "[ERROR]: PDF_INPUT — Missing 'html' content.";

    const looksFullHtml = /<html[\s>]/i.test(rawHtml) || /<!doctype/i.test(rawHtml) || /<head[\s>]/i.test(rawHtml);
    let css = cssInput;

    if (!css && looksFullHtml) {
      const inlineCss = extractInlineCssFromFullHtml(rawHtml);
      if (inlineCss) css = inlineCss;
    }
    if (!css) css = getDefaultCss();

    let fullHtml;

    if (!cssInput && looksFullHtml) {
      // Original HTML komplett rendern und Hardening-CSS injizieren
      fullHtml = injectHardeningCss(rawHtml, HARDENING_CSS);
    } else {
      // Eigenen Head bauen: geliefertes/Default-CSS + Hardening-CSS (Hardening immer zuletzt)
      const bodyHtml = extractBody(rawHtml);
      const docTitle = title || "Document";
      fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(docTitle)}</title>
  <style>${css}</style>
  <style id="__pdf_hardening__">${HARDENING_CSS}</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
    }

    // Render (A4 + 1cm Ränder HART per Puppeteer; überschreibt CSS @page)
    const documentsDir = path.join(__dirname, "documents");
    await fs.mkdir(documentsDir, { recursive: true });

    const filename = normalizeFilename(filenameArg || title || "document");
    const publicPath = `/documents/${filename}.pdf`;
    const pdfPath = path.join(documentsDir, `${filename}.pdf`);

    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
    const page = await browser.newPage();
    await page.setContent(fullHtml, { waitUntil: "load" });
    await page.pdf({
      path: pdfPath,
      format: "A4",
      margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
      printBackground: true,
      preferCSSPageSize: false // sorgt dafür, dass 'format' greift, nicht @page size
    });

    const publicUrl = ensureAbsoluteUrl(publicPath);
    const preview = getPlainFromHTML(rawHtml, 2000);

    // Für Transparenz: kombiniertes CSS zurückgeben (User/Default ist im HTML enthalten;
    // hier geben wir nur das Hardening separat aus, weil es garantiert aktiv ist.)
    const usedCssReport = [
      "/* --- User/Provided or Default CSS is embedded in <head> --- */",
      "/* --- Hardening CSS (enforced) --- */",
      HARDENING_CSS
    ].join("\n");

    return [
      `PDF: ${publicUrl}`,
      `<${publicUrl}>`,
      "",
      "### Plaintext Preview",
      preview,
      "",
      "### Stylesheet Used (Hardening part)",
      usedCssReport
    ].join("\n");

  } catch (err) {
    await reportError(err, null, "PDF_UNEXPECTED", "FATAL");
    return "[ERROR]: PDF_UNEXPECTED — Could not generate PDF.";
  } finally {
    try { await browser?.close(); } catch {}
  }
}

module.exports = { getPDF };

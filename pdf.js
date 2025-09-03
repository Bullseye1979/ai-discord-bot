// pdf.js — stable renderer v1.3 (lenient args + inline images)
// Input:  { html, css?, filename?, title?, user_id? } via tool args (string or object)
// Output: Text mit Public-URL, Plaintext-Preview, angewandtem CSS und Inliner-Stats.
//
// Neuerungen in v1.3:
//  - Super-robustes safeParseToolArgs:
//      * Entfernt Codefences/BOM/Smart-Quotes
//      * Versucht JSON.parse
//      * Versucht "balanced braces slice" (erste { .. passende } ) zu parsen
//      * Wenn alles scheitert und raw wie HTML aussieht → { html: raw }
//  - Bild-Inlining (http/https → data:URI) bleibt, um ablaufende Links zu entschärfen
//  - Harte Layout-Regeln (A4, 10mm Margin, keine Split-Table/Fig/Img/Blockquote)

const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs/promises");
const axios = require("axios");
const { reportError } = require("./error.js");
const { getPlainFromHTML } = require("./helper.js");

/* ======================== Config ======================== */
const INLINE_IMG_MAX_COUNT = Number(process.env.PDF_INLINE_IMG_MAX_COUNT || 32);    // max Bilder
const INLINE_IMG_MAX_BYTES = Number(process.env.PDF_INLINE_IMG_MAX_BYTES || 5_000_000); // 5MB je Bild
const INLINE_IMG_TIMEOUT_MS = Number(process.env.PDF_INLINE_IMG_TIMEOUT || 15000);  // 15s timeout pro Bild

/* ======================== Utils ========================= */

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

/** Detects if the string is likely raw HTML (so we can fall back). */
function looksLikeHtml(s) {
  const t = String(s || "");
  return /<\s*(html|body|h1|div|section|article|p|table|img)\b/i.test(t);
}

/** Try to extract a balanced {...} slice from a raw string and parse it. */
function tryParseBalancedJson(raw) {
  const str = String(raw || "");
  const start = str.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let esc = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (inString) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inString = false;
      }
    } else {
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const slice = str.slice(start, i + 1);
          try { return JSON.parse(slice); } catch { return null; }
        }
      }
    }
  }
  return null;
}

/** Parse tool args safely. Never throw. */
function safeParseToolArgs(toolFunction) {
  try {
    const a = toolFunction?.arguments;

    // If the SDK already gave an object, we are done.
    if (a && typeof a === "object") return { ok: true, args: a };

    const raw = cleanseArgString(String(a || ""));

    // 1) Try direct JSON.parse
    try {
      const parsed = JSON.parse(raw);
      return { ok: true, args: parsed };
    } catch {}

    // 2) Try removing trailing commas
    try {
      const repaired = raw.replace(/,\s*([}\]])/g, "$1");
      const parsed2 = JSON.parse(repaired);
      return { ok: true, args: parsed2 };
    } catch {}

    // 3) Try balanced slice { ... } and parse that
    const balanced = tryParseBalancedJson(raw);
    if (balanced && typeof balanced === "object") {
      return { ok: true, args: balanced };
    }

    // 4) Fallback: if it looks like HTML, use it as html param
    if (looksLikeHtml(raw)) {
      return { ok: true, args: { html: raw } };
    }

    // 5) Last resort: wrap raw in a paragraph as html (prevents hard failure)
    if (raw) {
      const wrapped = `<pre>${escapeHtml(raw)}</pre>`;
      return { ok: true, args: { html: wrapped } };
    }

    return { ok: false, error: "Failed to parse getPDF tool arguments", raw };
  } catch (e) {
    reportError(e, null, "PDF_ARGS_PARSE", "ERROR");
    return { ok: false, error: "Failed to parse getPDF tool arguments" };
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

/** Minimal HTML escaper for <title> and pre fallback. */
function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* ============= Hard CSS (nicht überschreibbar) ============= */
/**
 * Nicht überschreibbare Regeln (hohe Spezifität + !important):
 *  - A4, 10mm Ränder
 *  - keine Splits in Tabellen, Figuren, Blockquotes, Bildern
 *  - Bilder auf Seitenbreite skalieren
 */
function hardCss() {
  return [
    "@page{size:A4;margin:10mm !important}",
    "html, body{margin:0 !important;padding:0 !important}",
    "html body{padding:0 !important}",
    "html body table, html body tr, html body td, html body th, html body thead, html body tbody{page-break-inside: avoid !important; break-inside: avoid !important}",
    "html body figure, html body blockquote, html body pre, html body code{page-break-inside: avoid !important; break-inside: avoid !important}",
    "html body img{max-width:100% !important;height:auto !important;display:block !important;page-break-inside: avoid !important; break-inside: avoid !important}",
  ].join("");
}

/* ============= HTML Document Wrapper ============= */

function buildHtmlDocument(bodyHtml, userCss, title = "Document") {
  const hard = hardCss();
  const safeCss = String(userCss || "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title || "Document")}</title>
  <style id="hard-rules">
  ${hard}
  </style>
  <style id="user-styles">
  ${safeCss}
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/* ============= Image Inlining (Data URI) ============= */

/** Finde http/https IMG-Quellen (keine data:, blob:, file:, keine {platzhalter}). */
function findRemoteImageSrcs(html) {
  const out = [];
  const re = /<img\b[^>]*\bsrc\s*=\s*(['"])(.*?)\1/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const src = (m[2] || "").trim();
    if (!src) continue;
    // ignore placeholders in { … }
    if (/^\{\s*.+\s*\}$/.test(src)) continue;
    // allow only http(s)
    if (!/^https?:\/\//i.test(src)) continue;
    // ignore data:, blob:, file:
    if (/^(data|blob|file):/i.test(src)) continue;
    out.push({ src, index: m.index });
  }
  return out;
}

/** Laden einer Bild-URL → data:URI (Base64), mit Size- und Timeout-Limits. */
async function fetchImageAsDataUri(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INLINE_IMG_TIMEOUT_MS);

  try {
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      signal: controller.signal,
      maxContentLength: INLINE_IMG_MAX_BYTES,
      timeout: INLINE_IMG_TIMEOUT_MS,
      headers: {
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0 (compatible; PDFBot/1.3; +https://example.com)",
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });

    const bytes = res.data;
    if (!bytes || !Buffer.isBuffer(bytes)) {
      throw new Error("No image bytes");
    }
    if (bytes.length > INLINE_IMG_MAX_BYTES) {
      throw new Error(`Image too large (${bytes.length} bytes)`);
    }

    // content-type fallback
    let ct =
      res.headers["content-type"] ||
      res.headers["Content-Type"] ||
      "";

    // Simple fallback by URL extension
    if (!/^image\//i.test(ct)) {
      if (/\.png(\?|#|$)/i.test(url)) ct = "image/png";
      else if (/\.jpe?g(\?|#|$)/i.test(url)) ct = "image/jpeg";
      else if (/\.gif(\?|#|$)/i.test(url)) ct = "image/gif";
      else if (/\.webp(\?|#|$)/i.test(url)) ct = "image/webp";
      else if (/\.svg(\?|#|$)/i.test(url)) ct = "image/svg+xml";
      else ct = "application/octet-stream";
    }

    const b64 = Buffer.from(bytes).toString("base64");
    return `data:${ct};base64,${b64}`;
  } finally {
    clearTimeout(timer);
  }
}

/** Ersetzt remote IMG-URLs im HTML durch data:URIs (bis zu Limits). */
async function inlineImages(html) {
  const imgs = findRemoteImageSrcs(html);
  if (imgs.length === 0) return { html, stats: { found: 0, inlined: 0, skipped: 0 } };

  const limited = imgs.slice(0, INLINE_IMG_MAX_COUNT);
  let inlined = 0, skipped = 0;
  let out = html;

  // Wir ersetzen von hinten nach vorne, damit Indizes stabil bleiben:
  for (let i = limited.length - 1; i >= 0; i--) {
    const { src } = limited[i];
    try {
      const dataUri = await fetchImageAsDataUri(src);
      // replace only that exact occurrence (src="…")
      const safeSrc = src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(<img\\b[^>]*\\bsrc\\s*=\\s*["'])${safeSrc}(["'][^>]*>)`, "i");
      out = out.replace(re, `$1${dataUri}$2`);
      inlined++;
    } catch (e) {
      await reportError(e, null, "PDF_INLINE_IMG", "WARN", { url: src });
      skipped++;
    }
  }

  return { html: out, stats: { found: imgs.length, inlined, skipped } };
}

/* ======================== Main Tool ======================== */

async function getPDF(toolFunction /*, context, getAIResponse */) {
  let browser = null;
  try {
    // 1) Argumente parsen (robust)
    const parsed = safeParseToolArgs(toolFunction);
    if (!parsed.ok) {
      // Soft reply (kein Throw), damit aiCore IMMER eine Tool-Antwort hat
      return JSON.stringify({
        ok: false,
        error: parsed.error || "Failed to parse getPDF tool arguments",
        hint: "Sende gültiges JSON oder reines HTML als String.",
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
        hint: "Sende mindestens { html: \"...\" } oder übergib reines HTML als Tool-Argument.",
      });
    }

    // 2) HTML vorbereiten: Scripts entfernen, auf body-Content reduzieren
    const bodyRaw = stripScripts(extractBody(htmlInput));

    // 3) Remote-Bilder inlinen (data:URI), damit Render stabil ist
    const { html: bodyWithImages, stats: inlineStats } = await inlineImages(bodyRaw);

    // 4) HTML-Dokument zusammenbauen
    const htmlDoc = buildHtmlDocument(bodyWithImages, cssInput, title);

    // 5) Dateipfade/URLs
    const documentsDir = path.join(__dirname, "documents");
    await fs.mkdir(documentsDir, { recursive: true });

    const filename = normalizeFilename(filenameInput || (title || "document"));
    const pdfPath = path.join(documentsDir, `${filename}.pdf`);
    const publicPath = `/documents/${filename}.pdf`;
    const publicUrl = ensureAbsoluteUrl(publicPath);

    // 6) Rendern mit Puppeteer
    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
    const page = await browser.newPage();

    await page.setDefaultNavigationTimeout(60000);
    await page.setDefaultTimeout(60000);

    await page.setContent(htmlDoc, { waitUntil: "load" });

    // Bilder fertig laden (auch wenn data:URI meist sofort ready ist)
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
      // @page margin (10mm) kommt aus hardCss(); kein margin-Override hier setzen
    });

    // 7) Preview + Rückgabe
    const preview = getPlainFromHTML(bodyWithImages, 2000);

    const lines = [];
    lines.push(`PDF: ${publicUrl}`);
    lines.push(`<${publicUrl}>`);
    lines.push("");
    lines.push(`--- Plaintext Preview ---`);
    lines.push(preview);
    lines.push("");
    lines.push(`--- CSS Used ---`);
    lines.push("```css");
    lines.push(cssInput || "/* (no user CSS provided) */");
    lines.push("```");
    lines.push("");
    lines.push(`--- Image Inlining ---`);
    lines.push(`found=${inlineStats.found}, inlined=${inlineStats.inlined}, skipped=${inlineStats.skipped}`);

    return lines.join("\n");
  } catch (err) {
    await reportError(err, null, "PDF_UNEXPECTED", "ERROR");
    return JSON.stringify({
      ok: false,
      error: "PDF_UNEXPECTED — Could not generate PDF.",
      details: err?.message || String(err),
    });
  } finally {
    try { await browser?.close(); } catch {}
  }
}

module.exports = { getPDF };

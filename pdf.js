// pdf.js — hardened v4.4 (tolerant args + dual save HTML/PDF + enforced print rules)
// - Ultra-tolerant args parsing (recovers incomplete/unterminated JSON strings)
// - Accepts: JSON object/string, fenced ```json, ```html/```css, full <html>…</html>, body-only HTML
// - Saves same-named .html next to .pdf
// - Returns JSON string: { ok, pdf, html, css, text, filename } (absolute URLs for pdf/html)
// - Enforces non-overridable print rules via last-in-cascade !important CSS

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

/** Extract innerHTML from <body> if full doc is supplied; else return as-is. */
function extractBody(html) {
  const s = String(html || "");
  const m = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (m) return m[1];
  return s;
}

/** Enforced CSS (last in cascade, !important) to lock down print layout. */
function enforcedCss() {
  return [
    // Page & margins (A4 + outer 20mm)
    "@page{size:A4;margin:20mm !important}",
    "html,body{margin:0 !important;padding:0 !important}",
    // Inner text padding 10mm
    "body{padding:10mm !important}",
    // Avoid splitting key elements across pages
    "table, thead, tbody, tr, th, td, figure, img, pre, blockquote{page-break-inside:avoid !important; break-inside:avoid !important}",
    "h1,h2,h3{break-after:avoid !important; page-break-after:auto !important}",
    // Image fit
    "img{max-width:100% !important; height:auto !important; display:block !important}",
  ].join("");
}

/** Wrap body HTML + CSS into a printable full HTML document. */
function buildPrintableHtml(bodyHtml, userCss = "", title = "Document") {
  const cssFinal = `${String(userCss || "")}\n${enforcedCss()}`;
  const safeTitle = String(title || "Document").slice(0, 140);
  const html = `<!DOCTYPE html>
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
  return { html, cssFinal };
}

/* ---------------------- Ultra-tolerant args parsing ---------------------- */
/**
 * Tolerant parser for getPDF tool arguments.
 * Accepts:
 *  - real JSON object, JSON string, fenced ```json,
 *  - fenced ```html / ```css blocks,
 *  - full <html>…</html> with optional <style>…</style>,
 *  - body-only HTML (with optional inline <style> blocks).
 */

/** Scan-based tolerant extractor for JSON string values like  "html":"...".
 *  - Respects escapes \" \\ \n \r \t \uXXXX
 *  - If closing quote is missing (unterminated), returns best-effort up to end.
 *  Returns { value, ok }.
 */
function tolerantExtractJsonStringValue(source, key) {
  const s = String(source || "");
  const reKey = new RegExp(`"${key}"\\s*:\\s*"`, "i");
  const m = s.match(reKey);
  if (!m) return { value: "", ok: false };
  let i = m.index + m[0].length; // start after the opening quote of the value

  let value = "";
  let ok = false;
  while (i < s.length) {
    const ch = s[i++];
    if (ch === "\\") {
      // escape
      if (i >= s.length) { value += "\\"; break; }
      const esc = s[i++];
      // Handle common escapes
      if (esc === "u") {
        // read up to 4 hex
        const hex = s.slice(i, i + 4);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          try { value += String.fromCharCode(parseInt(hex, 16)); } catch { value += "\\u" + hex; }
          i += 4;
        } else {
          value += "\\u";
        }
      } else {
        // simple escapes; preserve semantics for later HTML
        const map = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", '"': '"', "'": "'", "\\": "\\" };
        value += (map[esc] !== undefined) ? map[esc] : esc;
      }
    } else if (ch === '"') {
      ok = true; // properly terminated
      break;
    } else {
      value += ch;
    }
  }
  return { value, ok };
}

function safeParseToolArgs(toolFunction) {
  const raw = toolFunction?.arguments;

  // direct object case (already parsed)
  if (raw && typeof raw === "object") {
    return {
      html: String(raw.html || ""),
      css: String(raw.css || ""),
      title: raw.title ? String(raw.title) : "",
      filename: raw.filename ? String(raw.filename) : "",
      user_id: raw.user_id ? String(raw.user_id) : "",
    };
  }

  if (typeof raw !== "string") return {};

  const logPreview = (s, n = 2200) => s.slice(0, n);
  try { console.log("[PDF_ARGS_PARSE][raw typeof]", typeof raw); } catch {}
  try { console.log("[PDF_ARGS_PARSE][raw len]", raw.length); } catch {}
  try { console.log("[PDF_ARGS_PARSE][raw preview]", logPreview(raw)); } catch {}

  const str = raw.trim();

  // 0) Fast path: if it *looks* like plain HTML (starts with '<' and contains a tag), treat as HTML
  if (/^<[a-z!/]/i.test(str)) {
    const styleBlocks = [...str.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(x => x[1].trim());
    const css = styleBlocks.length ? styleBlocks.join("\n\n") : "";
    const html = str.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    return { html: html.trim(), css: css.trim(), title: "", filename: "", user_id: "" };
  }

  // 1) strict JSON
  try {
    const obj = JSON.parse(str);
    return {
      html: String(obj.html || ""),
      css: String(obj.css || ""),
      title: obj.title ? String(obj.title) : "",
      filename: obj.filename ? String(obj.filename) : "",
      user_id: obj.user_id ? String(obj.user_id) : "",
    };
  } catch (e) {
    try { console.log("[PDF_DEBUG] ARGS strict JSON failed:", e.message || String(e)); } catch {}
  }

  // 2) fenced ```json
  try {
    const s2 = str.replace(/^```(?:json|md)?\s*/i, "").replace(/```$/i, "");
    const obj = JSON.parse(s2);
    return {
      html: String(obj.html || ""),
      css: String(obj.css || ""),
      title: obj.title ? String(obj.title) : "",
      filename: obj.filename ? String(obj.filename) : "",
      user_id: obj.user_id ? String(obj.user_id) : "",
    };
  } catch (e) {
    try { console.log("[PDF_DEBUG] ARGS fenced JSON failed:", e.message || String(e)); } catch {}
  }

  // 2b) Tolerant recovery for JSON-like input with unterminated strings
  // Try to extract "html":"..." and optionally "css":"..." without full JSON parse.
  if (/"html"\s*:/i.test(str)) {
    const htmlRec = tolerantExtractJsonStringValue(str, "html");
    const cssRec  = tolerantExtractJsonStringValue(str, "css");
    const titleRec = tolerantExtractJsonStringValue(str, "title");
    const filenameRec = tolerantExtractJsonStringValue(str, "filename");

    if (htmlRec.value) {
      // If html contains embedded <style> blocks and css is empty, split them out
      let html = htmlRec.value;
      let css = cssRec.value || "";
      if (!css && /<style[^>]*>[\s\S]*?<\/style>/i.test(html)) {
        const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1].trim());
        css = styles.join("\n\n");
        html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
      }
      return {
        html: String(html).trim(),
        css: String(css).trim(),
        title: String(titleRec.value || "").trim(),
        filename: String(filenameRec.value || "").trim(),
        user_id: "",
      };
    }
  }

  // Helper: extract fenced blocks by language
  const extractFence = (all, lang) => {
    const re = new RegExp("```" + lang + "\\s*([\\s\\S]*?)```", "i");
    const m = all.match(re);
    return m ? m[1].trim() : "";
  };

  // 3) ```html and/or ```css blocks
  const fencedHtml = extractFence(str, "html");
  const fencedCss  = extractFence(str, "css");
  if (fencedHtml || fencedCss) {
    let html = fencedHtml || "";
    let css  = fencedCss || "";

    // if no fenced html but string still contains <html>…</html>, try to pull it
    if (!html) {
      const m = str.match(/<html[^>]*>[\s\S]*?<\/html>/i);
      if (m) html = m[0];
    }
    // also pull <style>…</style> from html if css empty
    if (!css && html) {
      const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(x => x[1].trim());
      if (styleBlocks.length) css = styleBlocks.join("\n\n");
    }
    // remove inline style blocks from html (stylesheet comes separately)
    if (html) html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");

    return { html: html.trim(), css: String(css || "").trim(), title: "", filename: "", user_id: "" };
  }

  // 4) Raw HTML document <html>…</html>
  const htmlDocMatch = str.match(/<html[^>]*>[\s\S]*?<\/html>/i);
  if (htmlDocMatch) {
    let html = htmlDocMatch[0];
    const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(x => x[1].trim());
    const css = styleBlocks.length ? styleBlocks.join("\n\n") : "";
    html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    return { html: html.trim(), css: css.trim(), title: "", filename: "", user_id: "" };
  }

  // 5) Body-only fallback: has HTML tags anywhere? (even inside otherwise JSON-like text)
  if (/[<][a-z][\s>]/i.test(str)) {
    const styleBlocks = [...str.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(x => x[1].trim());
    const css = styleBlocks.length ? styleBlocks.join("\n\n") : "";
    const html = str.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    return { html: html.trim(), css: css.trim(), title: "", filename: "", user_id: "" };
  }

  // 6) Last resort: treat as plain text/HTML body string
  return { html: str, css: "", title: "", filename: "", user_id: "" };
}

/* ------------------------- Main Tool Entry ------------------------- */

as

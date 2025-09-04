// pdf.js — stable v4.3 (tolerant args + dual save HTML/PDF + enforced print rules)
// - Robust args parsing (JSON, fenced ```json, ```html/```css, full <html>…, or body-only HTML)
// - Saves a same-named .html next to the .pdf
// - Returns JSON string: { ok, pdf, html, css, text, filename }  (absolute URLs for pdf/html)
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
function safeParseToolArgs(toolFunction) {
  const raw = toolFunction?.arguments;

  // direct object case
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

    // remove inline style blocks from html (stylesheet kommt separat)
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

  // 5) Body-only fallback: has HTML tags?
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

async function getPDF(toolFunction /*, context, getAIResponse */) {
  let browser = null;
  try {
    // Parse args robustly
    let args;
    try {
      args = safeParseToolArgs(toolFunction);
    } catch (e) {
      await reportError(e, null, "PDF_ARGS_PARSE");
      // Also log a minimal debug line for quicker triage
      try {
        const raw = toolFunction?.arguments;
        console.log("[PDF_ARGS_PARSE][raw typeof]", typeof raw);
        if (typeof raw === "string") {
          console.log("[PDF_ARGS_PARSE][raw len]", raw.length);
          console.log("[PDF_ARGS_PARSE][raw preview]", raw.slice(0, 1800));
        }
      } catch {}
      throw e;
    }

    const htmlIn = String(args.html || "").trim();
    const cssIn = String(args.css || ""); // required by tools spec now, aber wir tolerieren leer
    const title = String(args.title || "");
    const filenameArg = String(args.filename || "");

    if (!htmlIn) {
      return JSON.stringify({ ok: false, error: "PDF_INPUT — Missing 'html' content." });
    }

    // Prepare content
    const bodyHtml = extractBody(htmlIn);
    const { html: fullHtml, cssFinal } = buildPrintableHtml(bodyHtml, cssIn, title || "Document");

    // Paths
    const documentsDir = path.join(__dirname, "documents");
    await fs.mkdir(documentsDir, { recursive: true });

    const filename = normalizeFilename(filenameArg, "");
    const baseName = filename || normalizeFilename(title, "") || normalizeFilename("document");
    const pdfPath = path.join(documentsDir, `${baseName}.pdf`);
    const htmlPath = path.join(documentsDir, `${baseName}.html`);

    // Write standalone HTML file
    await fs.writeFile(htmlPath, fullHtml, "utf8");

    // Render PDF with Puppeteer
    const launchOpts = { headless: "new", args: ["--no-sandbox"] };
    browser = await puppeteer.launch(launchOpts);
    const page = await browser.newPage();

    // Load our local HTML; wait for images/resources (helps image reliability)
    await page.setContent(fullHtml, { waitUntil: "networkidle0", timeout: 120000 });

    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      // margins 0 here because @page margin is already enforced in CSS
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });

    // Public URLs
    const publicPdf = ensureAbsoluteUrl(`/documents/${path.basename(pdfPath)}`);
    const publicHtml = ensureAbsoluteUrl(`/documents/${path.basename(htmlPath)}`);

    // Clean text preview from BODY content (full text, no html)
    const plainText = getPlainFromHTML(bodyHtml, 200000); // generous

    // Return structured JSON (string)
    return JSON.stringify({
      ok: true,
      pdf: publicPdf,
      html: publicHtml,
      css: cssFinal,
      text: plainText,
      filename: baseName
    });
  } catch (err) {
    await reportError(err, null, "PDF_UNEXPECTED", "FATAL");
    return JSON.stringify({ ok: false, error: "PDF_UNEXPECTED — Could not generate PDF/HTML." });
  } finally {
    try { await browser?.close(); } catch {}
  }
}

module.exports = { getPDF };

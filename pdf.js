// pdf.js — stable v4.3.1 (debuggable)
// Input:  { html: string, css?: string, filename?: string, title?: string, user_id?: string }
// Output: JSON string with { ok, pdf, html, css_final, text }.
// - Enforces non-overridable print rules (A4, margins, padding, no table/figure splits).
// - Saves same-named .html alongside the .pdf
// - Returns absolute URLs using PUBLIC_BASE_URL (or BASE_URL) if set.
// - DEBUG: set PDF_DEBUG=1 to see raw args + parse steps.

const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs/promises");
const { reportError } = require("./error.js");
const { getPlainFromHTML } = require("./helper.js");

/* ------------------------- Debug helpers ------------------------- */

const PDF_DEBUG = String(process.env.PDF_DEBUG || "").toLowerCase() === "1" ||
                  String(process.env.PDF_DEBUG || "").toLowerCase() === "true";

function dbg(...args) {
  if (PDF_DEBUG) {
    try { console.log("[PDF_DEBUG]", ...args); } catch {}
  }
}

function previewStr(s, n = 500) {
  try {
    const str = String(s ?? "");
    return str.length > n ? str.slice(0, n) + "…[truncated]" : str;
  } catch { return "[[unavailable]]"; }
}

/* ------------------------- Core helpers ------------------------- */

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

/** Enforced CSS that cannot be overridden (element selectors + !important, appended last). */
function enforcedCss() {
  return [
    // A4 + 20mm outer margin
    "@page{size:A4;margin:20mm !important}",
    "html,body{margin:0 !important;padding:0 !important}",
    // 10mm inner padding (1cm) for readable text inset
    "body{padding:10mm !important}",
    // Avoid splitting important blocks
    "table, thead, tbody, tr, th, td, figure, img, pre, blockquote{page-break-inside:avoid !important; break-inside:avoid !important}",
    "h1,h2,h3{break-after:avoid !important; page-break-after:auto !important}",
    // Image fit
    "img{max-width:100% !important; height:auto !important; display:block !important}"
  ].join("");
}

/** Default base CSS (magazine-like, safe). */
function defaultCss() {
  return [
    "body{font-family:Arial,Helvetica,sans-serif;font-size:12pt;line-height:1.6;color:#111}",
    "h1{font-size:22pt;margin:0 0 .5rem 0;line-height:1.25;color:#0a66c2}",
    "h2{font-size:16pt;margin:1.2rem 0 .5rem 0;line-height:1.25;color:#0a66c2}",
    "h3{font-size:13pt;margin:1rem 0 .4rem 0;line-height:1.25;color:#0a66c2}",
    "p{margin:.6rem 0;text-align:justify}",
    "ul,ol{margin:.6rem 0 .6rem 1.2rem}",
    "li{margin:.2rem 0}",
    "blockquote{margin:.8rem 0;padding:.6rem 1rem;border-left:3px solid #0a66c2;color:#555}",
    "hr{border:0;border-top:1px solid #ddd;margin:1rem 0}",
    "table{border-collapse:collapse;width:100%;margin:.6rem 0}",
    "thead th{background:#0a66c2;color:#fff;padding:.45rem .6rem;text-align:left}",
    "tbody tr:nth-child(even){background:#f6f8fa}",
    "th,td{border:1px solid #d0d7de;padding:.35rem .5rem;vertical-align:top}",
    "code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10pt}",
    "pre{white-space:pre-wrap;background:#f8f8f8;border:1px solid #ddd;padding:.6rem}",
  ].join("");
}

/** Wrap body HTML + CSS into a printable full HTML document. */
function buildPrintableHtml(bodyHtml, userCss = "", title = "Document") {
  // final CSS = user CSS (or default) + enforced CSS (with !important)
  const user = String(userCss || defaultCss());
  const css_final = `${user}\n${enforcedCss()}`;
  const safeTitle = String(title || "Document").slice(0, 140);
  const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${safeTitle}</title>
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>${css_final}</style>
</head>
<body>
${bodyHtml || ""}
</body>
</html>`;
  return { fullHtml, css_final };
}

/* ------------------------- Robust args parser (with debug) ------------------------- */

/**
 * Try several parsing strategies and log each attempt if PDF_DEBUG=1.
 * - Accepts object directly
 * - Tries strict JSON
 * - Tries removing ```json fences
 * - Tries normalizing smart quotes
 * - As a last resort, throws
 */
function safeParseToolArgs(toolFunction) {
  const raw = toolFunction?.arguments;
  dbg("ARGS raw typeof:", typeof raw);

  if (raw == null) return {};
  if (typeof raw === "object") {
    dbg("ARGS accepted as object keys:", Object.keys(raw || {}));
    return raw;
  }

  if (typeof raw === "string") {
    const str = raw.trim();
    dbg("ARGS raw string length:", str.length);
    dbg("ARGS raw string preview:", previewStr(str));

    // Attempt 1: strict JSON
    try {
      const obj1 = JSON.parse(str);
      dbg("ARGS parsed via strict JSON; keys:", Object.keys(obj1 || {}));
      return obj1;
    } catch (e1) {
      dbg("ARGS strict JSON failed:", String(e1 && e1.message));
    }

    // Attempt 2: strip ```json / ``` fences
    const s2 = str.replace(/^```(?:json|md)?\s*/i, "").replace(/```$/i, "");
    if (s2 !== str) {
      dbg("ARGS trying without code fences...");
      try {
        const obj2 = JSON.parse(s2);
        dbg("ARGS parsed via no-fence JSON; keys:", Object.keys(obj2 || {}));
        return obj2;
      } catch (e2) {
        dbg("ARGS no-fence JSON failed:", String(e2 && e2.message));
      }
    }

    // Attempt 3: normalize smart quotes → straight quotes (common copy/paste issue)
    const s3 = s2
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'");

    if (s3 !== s2) {
      dbg("ARGS trying with normalized quotes...");
      try {
        const obj3 = JSON.parse(s3);
        dbg("ARGS parsed via normalized-quotes JSON; keys:", Object.keys(obj3 || {}));
        return obj3;
      } catch (e3) {
        dbg("ARGS normalized-quotes JSON failed:", String(e3 && e3.message));
      }
    }

    // Attempt 4 (optional): very naive trailing commas removal in objects/arrays
    const s4 = s3
      .replace(/,\s*([}\]])/g, "$1"); // remove ", }" or ", ]"
    if (s4 !== s3) {
      dbg("ARGS trying after trailing-comma cleanup...");
      try {
        const obj4 = JSON.parse(s4);
        dbg("ARGS parsed via trailing-comma cleanup; keys:", Object.keys(obj4 || {}));
        return obj4;
      } catch (e4) {
        dbg("ARGS trailing-comma cleanup failed:", String(e4 && e4.message));
      }
    }

    // If we reach here, we give up to avoid misinterpreting garbage as content
    throw new Error("Failed to parse getPDF tool arguments");
  }

  // Not object or string
  dbg("ARGS: unsupported type:", typeof raw);
  return {};
}

/* ------------------------- Main Tool Entry ------------------------- */

async function getPDF(toolFunction /*, context, getAIResponse */) {
  let browser = null;
  try {
    // Parse args robustly with debug
    let args;
    try {
      args = safeParseToolArgs(toolFunction);
    } catch (e) {
      await reportError(e, null, "PDF_ARGS_PARSE");
      // Zusätzlich: Rohdaten in WARN-Log um die Auslöser zu sehen
      try {
        const raw = toolFunction?.arguments;
        console.warn("[PDF_ARGS_PARSE][raw typeof]", typeof raw);
        if (typeof raw === "string") {
          console.warn("[PDF_ARGS_PARSE][raw len]", raw.length);
          console.warn("[PDF_ARGS_PARSE][raw preview]", previewStr(raw, 800));
        } else if (typeof raw === "object") {
          console.warn("[PDF_ARGS_PARSE][raw keys]", Object.keys(raw || {}));
        } else {
          console.warn("[PDF_ARGS_PARSE][raw]", raw);
        }
      } catch {}
      throw e;
    }

    // Show parsed keys & types
    try {
      const typed = {};
      for (const k of Object.keys(args || {})) {
        typed[k] = typeof args[k];
      }
      dbg("ARGS parsed keys+types:", typed);
    } catch {}

    const htmlIn = String(args.html || "").trim();
    const cssIn = String(args.css || "");      // optional
    const title = String(args.title || "");    // optional
    const filenameArg = String(args.filename || ""); // optional

    if (!htmlIn) {
      return JSON.stringify({ ok: false, error: "PDF_INPUT — Missing 'html' content." });
    }

    // Prepare content
    const bodyHtml = extractBody(htmlIn);
    const { fullHtml, css_final } = buildPrintableHtml(bodyHtml, cssIn, title || "Document");

    // Paths
    const documentsDir = path.join(__dirname, "documents");
    await fs.mkdir(documentsDir, { recursive: true });

    const filename = normalizeFilename(filenameArg, "");
    const baseName =
      filename ||
      normalizeFilename(title, "") ||
      normalizeFilename("document");

    const pdfPath = path.join(documentsDir, `${baseName}.pdf`);
    const htmlPath = path.join(documentsDir, `${baseName}.html`);

    // Write standalone HTML file (for direct viewing)
    await fs.writeFile(htmlPath, fullHtml, "utf8");

    // Render PDF with Puppeteer
    const launchOpts = { headless: "new", args: ["--no-sandbox"] };
    browser = await puppeteer.launch(launchOpts);
    const page = await browser.newPage();

    // Load our local HTML via setContent; wait for images to settle
    await page.setContent(fullHtml, { waitUntil: "networkidle0", timeout: 120000 });

    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      // Margins handled via @page to avoid double margins
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });

    const publicPdf = ensureAbsoluteUrl(`/documents/${path.basename(pdfPath)}`);
    const publicHtml = ensureAbsoluteUrl(`/documents/${path.basename(htmlPath)}`);

    // Build plain text (no HTML)
    const text = getPlainFromHTML(bodyHtml, 200000);

    const payload = {
      ok: true,
      pdf: publicPdf,
      html: publicHtml,
      css_final,
      text
    };
    dbg("RETURN payload keys:", Object.keys(payload));
    return JSON.stringify(payload);
  } catch (err) {
    await reportError(err, null, "PDF_UNEXPECTED", "FATAL");
    return JSON.stringify({ ok: false, error: "PDF_UNEXPECTED — Could not generate PDF/HTML." });
  } finally {
    try { await browser?.close(); } catch {}
  }
}

module.exports = { getPDF };

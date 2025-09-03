// pdf.js — stable v4.2
// Render provided HTML (+ optional CSS) into a PDF AND save a same-named .html file.
// Returns plain-text preview + absolute links to PDF and HTML.
// Enforces non-overridable print rules: A4, 20mm page margin, 10mm inner padding, avoid split of tables/figures/etc.

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

/** If arguments come as bad JSON/code-fenced text, try to recover. */
function safeParseToolArgs(toolFunction) {
  const raw = toolFunction?.arguments;
  if (!raw) return {};
  if (typeof raw === "object") return raw;

  if (typeof raw === "string") {
    const str = raw.trim();
    // direct JSON
    try { return JSON.parse(str); } catch {}
    // strip ```json ... ``` wrappers
    const s2 = str.replace(/^```(?:json|md)?\s*/i, "").replace(/```$/i, "");
    try { return JSON.parse(s2); } catch {}
    // last resort: try to detect simple "html":"..." patterns? → give up to avoid corrupt input
    throw new Error("Failed to parse getPDF tool arguments");
  }
  return {};
}

/** Build absolute URL from PUBLIC_BASE_URL (or BASE_URL) + path. */
function ensureAbsoluteUrl(urlPath) {
  const base = (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "").replace(/\/$/, "");
  if (/^https?:\/\//i.test(urlPath)) return urlPath;
  if (base) return `${base}${urlPath.startsWith("/") ? "" : "/"}${urlPath}`;
  return urlPath; // relative fallback (still returned)
}

/** Extract body innerHTML if a full HTML document was supplied. */
function extractBody(html) {
  const s = String(html || "");
  const m = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (m) return m[1];
  // otherwise, assume body-only content
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
    "table, thead, tbody, tr, th, td, figure, img, pre, blockquote{page-break-inside:avoid !important; break-inside:avoid !important}",
    "h1,h2,h3{break-after:avoid !important; page-break-after:auto !important}",
    // Image fit
    "img{max-width:100% !important; height:auto !important; display:block !important}",
  ].join("");
}

/** Wrap body HTML + CSS into a printable full HTML document. */
function buildPrintableHtml(bodyHtml, userCss = "", title = "Document") {
  // User CSS comes first, enforced CSS last (with !important) so it wins the cascade.
  const css = `${String(userCss || "")}\n${enforcedCss()}`;
  const safeTitle = String(title || "Document").slice(0, 140);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${safeTitle}</title>
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>${css}</style>
</head>
<body>
${bodyHtml || ""}
</body>
</html>`;
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
    const cssIn = String(args.css || "");
    const title = String(args.title || "");
    const filenameArg = String(args.filename || "");
    const userId = String(args.user_id || ""); // optional, for logging/attribution if you need later

    if (!htmlIn) {
      return "[ERROR]: PDF_INPUT — Missing 'html' content.";
    }

    // Prepare content
    const bodyHtml = extractBody(htmlIn);
    const fullHtml = buildPrintableHtml(bodyHtml, cssIn, title || "Document");

    // Paths
    const documentsDir = path.join(__dirname, "documents");
    await fs.mkdir(documentsDir, { recursive: true });

    const filename = normalizeFilename(filenameArg, "");
    const baseName = filename || normalizeFilename(title, "") || normalizeFilename("document");
    const pdfPath = path.join(documentsDir, `${baseName}.pdf`);
    const htmlPath = path.join(documentsDir, `${baseName}.html`);

    // Write standalone HTML file (for direct viewing)
    await fs.writeFile(htmlPath, fullHtml, "utf8");

    // Render PDF with Puppeteer
    const launchOpts = { headless: "new", args: ["--no-sandbox"] };
    browser = await puppeteer.launch(launchOpts);
    const page = await browser.newPage();

    // Load our local HTML via setContent to respect CSS; wait for network for images
    await page.setContent(fullHtml, { waitUntil: "networkidle0", timeout: 120000 });

    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      // We already enforce margins via @page; avoid double margins here by using minimal ones:
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });

    const publicPdf = ensureAbsoluteUrl(`/documents/${path.basename(pdfPath)}`);
    const publicHtml = ensureAbsoluteUrl(`/documents/${path.basename(htmlPath)}`);

    // Build a clean text preview from the BODY content
    const preview = getPlainFromHTML(bodyHtml, 2000);

    // Return both links (angle brackets often help embeds become clickable)
    return `PDF: ${publicPdf}\nHTML: ${publicHtml}\n<${publicPdf}>\n<${publicHtml}>\n\n${preview}`;
  } catch (err) {
    await reportError(err, null, "PDF_UNEXPECTED", "FATAL");
    return "[ERROR]: PDF_UNEXPECTED — Could not generate PDF/HTML.";
  } finally {
    try { await browser?.close(); } catch {}
  }
}

module.exports = { getPDF };

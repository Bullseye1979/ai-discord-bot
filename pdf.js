// pdf.js — stable v1.0
// Takes HTML + CSS, merges them, renders PDF with Puppeteer.
// Features: enforced A4 + 1cm margins, waits for images, optional image inlining.

const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");
const axios = require("axios");

const { reportError } = require("./error.js");

/** Normalize filename (lowercase, safe, max 40 chars, no extension). */
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

/** Inline remote images into <img src="data:..."> to avoid broken links. */
async function inlineImages(html) {
  const regex = /<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;
  const urls = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    urls.push(match[1]);
  }
  const unique = [...new Set(urls)];

  for (const url of unique) {
    if (!/^https?:\/\//i.test(url)) continue;
    try {
      const resp = await axios.get(url, { responseType: "arraybuffer", timeout: 30000 });
      const ct = resp.headers["content-type"] || "image/png";
      const b64 = Buffer.from(resp.data).toString("base64");
      const dataUri = `data:${ct};base64,${b64}`;
      html = html.replace(new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), dataUri);
    } catch (err) {
      await reportError(err, null, "PDF_INLINE_IMG", "WARN");
    }
  }
  return html;
}

/** Ensure base/public URL is absolute */
function ensureAbsoluteUrl(urlPath) {
  const base = (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "").replace(/\/$/, "");
  if (/^https?:\/\//i.test(urlPath)) return urlPath;
  if (base) {
    return `${base}${urlPath.startsWith("/") ? "" : "/"}${urlPath}`;
  }
  return urlPath;
}

/** Main entry: render PDF from HTML + CSS */
async function getPDF(toolFunction, context, getAIResponse) {
  let browser = null;
  try {
    let args;
    try {
      args =
        typeof toolFunction.arguments === "string"
          ? JSON.parse(toolFunction.arguments || "{}")
          : toolFunction.arguments || {};
    } catch (err) {
      await reportError(err, null, "PDF_ARGS_PARSE", "ERROR");
      throw new Error("Failed to parse getPDF tool arguments");
    }

    const htmlRaw = String(args.html || "").trim();
    const cssRaw = String(args.css || "").trim();
    const filename = normalizeFilename(args.filename || "document");
    const title = String(args.title || "Document").trim();

    if (!htmlRaw) {
      return "[ERROR]: PDF_INPUT — Missing 'html'.";
    }

    // Inline images if env flag is set
    let finalHtml = htmlRaw;
    if (process.env.INLINE_IMAGES === "true") {
      finalHtml = await inlineImages(finalHtml);
    }

    // Wrap with head + base CSS (A4 + margins enforced)
    const enforcedCss = `
      @page { size: A4; margin: 20mm; }
      html, body { margin:0; padding:10mm; }
      table, figure { page-break-inside: avoid; }
      img { max-width:100%; height:auto; display:block; page-break-inside: avoid; }
    `;
    const fullCss = enforcedCss + "\n" + (cssRaw || "");

    const styledHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>${fullCss}</style>
</head>
<body>
  ${finalHtml}
</body>
</html>`;

    // Prepare paths
    const documentsDir = path.join(__dirname, "documents");
    await fs.mkdir(documentsDir, { recursive: true });
    const pdfPath = path.join(documentsDir, `${filename}.pdf`);
    const publicPath = `/documents/${filename}.pdf`;

    // Launch Puppeteer
    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
    const page = await browser.newPage();
    await page.setContent(styledHtml, { waitUntil: "networkidle0" });

    // Wait for images to load
    await page.evaluate(async () => {
      const imgs = Array.from(document.images || []);
      await Promise.all(
        imgs.map((img) => {
          if (img.complete) return Promise.resolve();
          return new Promise((res) => {
            const done = () => res();
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
          });
        })
      );
    });

    // Export PDF
    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
    });

    const publicUrl = ensureAbsoluteUrl(publicPath);

    // Plain text (strip HTML)
    const plain = String(finalHtml)
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2000);

    return `${plain}\n\nPDF: ${publicUrl}\n<${publicUrl}>\n\n### CSS\n${fullCss}`;
  } catch (err) {
    await reportError(err, null, "PDF_UNEXPECTED", "FATAL");
    return "[ERROR]: PDF_UNEXPECTED — Could not generate PDF.";
  } finally {
    try {
      await browser?.close();
    } catch {}
  }
}

module.exports = { getPDF };

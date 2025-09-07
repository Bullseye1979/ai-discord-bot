// webpage.js — v1.6 (auto-summarize long pages, threshold 15k chars)
// Fetches a webpage via Puppeteer, strips UI/noise, returns clean plain text.
// If the extracted text is very long, we automatically summarize it with GPT-4.1
// in a single pass (no chunking), aiming for minimal information loss.

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { getAI } = require("./aiService.js");
const Context = require("./context.js");
const { reportError } = require("./error.js");

puppeteer.use(StealthPlugin());

// Character thresholds
const LONG_TEXT_THRESHOLD = 15_000;   // above this, summarize instead of returning raw text
const MAX_INPUT_CHARS     = 250_000;  // hard cap for what we feed to the model

// Model config for summaries
const WEB_SUMMARY_MODEL  = "gpt-4.1";
const WEB_SUMMARY_TOKENS = 1400;

/** Tool entry: Always return plain text (no HTML). For very long pages, return a faithful summary. */
async function getWebpage(toolFunction) {
  let browser;
  try {
    const args =
      typeof toolFunction.arguments === "string"
        ? JSON.parse(toolFunction.arguments || "{}")
        : (toolFunction.arguments || {});
    const url = String(args.url || "").trim();

    if (!url) return "[ERROR]: WEBPAGE_INPUT — Missing 'url'.";

    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-setuid-sandbox",
      ],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
      "Sec-Fetch-Mode": "navigate",
    });

    const resp = await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
    if (!resp) {
      await reportError(new Error("No response from page.goto"), null, "WEBPAGE_FETCH_NO_RESPONSE", "WARN");
      return "[ERROR]: WEBPAGE_FETCH — No response received.";
    }

    const status = resp.status();
    const ctype = String(resp.headers()?.["content-type"] || "").toLowerCase();

    if (status >= 400) {
      await reportError(new Error(`HTTP ${status} for ${url}`), null, "WEBPAGE_STATUS", "WARN");
      return `[ERROR]: WEBPAGE_STATUS — HTTP ${status} for ${url}`;
    }

    // JSON → return pretty-printed JSON as text (clipped)
    if (ctype.includes("application/json")) {
      const jsonText = await resp.text();
      if (!jsonText || jsonText.length < 2) {
        await reportError(new Error("Empty JSON response"), null, "WEBPAGE_JSON_EMPTY", "WARN");
        return "[ERROR]: WEBPAGE_JSON_EMPTY — No JSON content.";
      }
      try {
        const obj = JSON.parse(jsonText);
        const pretty = JSON.stringify(obj, null, 2);
        return pretty.slice(0, MAX_INPUT_CHARS);
      } catch {
        // Not strictly JSON? just return as-is clipped.
        return jsonText.slice(0, MAX_INPUT_CHARS);
      }
    }

    // HTML/XHTML → extract readable text
    if (ctype.includes("text/html") || ctype.includes("application/xhtml+xml")) {
      await page.waitForSelector("main, article, body", { timeout: 15000 }).catch(() => {});
      const { title, text } = await extractReadableText(page);

      const raw = ((title ? `${title}\n\n` : "") + text).trim();

      if (!raw || raw.length < 50) {
        const fallback = (await page.evaluate(() => document.body?.innerText || "")).trim();
        if (!fallback || fallback.length < 50) {
          await reportError(new Error("Could not extract meaningful text."), null, "WEBPAGE_CONTENT_EMPTY", "WARN");
          return "[ERROR]: WEBPAGE_CONTENT_EMPTY — Could not extract meaningful text.";
        }
        const clipped = fallback.slice(0, MAX_INPUT_CHARS);
        if (clipped.length > LONG_TEXT_THRESHOLD) {
          return await summarizeLikeHistory(clipped, url);
        }
        return clipped;
      }

      const clipped = raw.slice(0, MAX_INPUT_CHARS);
      if (clipped.length > LONG_TEXT_THRESHOLD) {
        return await summarizeLikeHistory(clipped, url);
      }
      return clipped;
    }

    // Other content types → return raw text (clipped) or error
    const rawOther = await resp.text().catch(() => "");
    if (!rawOther || !rawOther.length) {
      await reportError(new Error(`Unsupported content-type: ${ctype}`), null, "WEBPAGE_UNSUPPORTED_TYPE", "INFO");
      return "[ERROR]: WEBPAGE_UNSUPPORTED_TYPE — Unsupported content type.";
    }
    return rawOther.slice(0, 4000);
  } catch (e) {
    await reportError(e, null, "WEBPAGE_UNHANDLED", "ERROR");
    return `[ERROR]: WEBPAGE_UNHANDLED — ${e?.message || "Unexpected failure"}`;
  } finally {
    try { await browser?.close(); } catch {}
  }
}

/** Extract a page title and readable text from the DOM. */
async function extractReadableText(page) {
  return page.evaluate(() => {
    const remove = [
      "script","style","noscript","iframe","svg","canvas","form","nav","header","footer","aside",
      "picture","video","audio","source","template","link","meta","button","input","select","textarea",
      ".advertisement","[role='navigation']","[aria-hidden='true']",
    ];
    remove.forEach((sel) => document.querySelectorAll(sel).forEach((n) => n.remove()));

    const root = document.querySelector("article") || document.querySelector("main") || document.body;
    const ttl = document.title || "";

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const lines = [];
    let node;
    while ((node = walker.nextNode())) {
      const t = (node.nodeValue || "").replace(/\s+/g, " ").trim();
      if (t) lines.push(t);
    }

    const text = lines
      .map((l) => l.replace(/\u00a0/g, " ").trim())
      .filter((l) => l && l.length > 1)
      .join("\n");

    return { title: ttl, text };
  });
}

/** Single-pass, loss-minimizing summary using GPT-4.1, similar to the 'history' approach. */
async function summarizeLikeHistory(fullText, sourceUrl = null) {
  try {
    const ctx = new Context();
    await ctx.add(
      "system",
      "summarizer",
      [
        "You are a meticulous summarizer with a very large context window.",
        "Summarize the following page with minimal information loss.",
        "Preserve key names, figures, dates, terminology, and any URLs present.",
        "Use compact, well-structured output (headings + bullet points where useful).",
        "Write in the user's language if inferable (German if unsure).",
      ].join(" ")
    );
    if (sourceUrl) {
      await ctx.add("user", "url", `Source URL: ${sourceUrl}`);
    }
    await ctx.add("user", "full_text", fullText);

    const out = await getAI(ctx, WEB_SUMMARY_TOKENS, WEB_SUMMARY_MODEL);
    return (out || "").trim() || "[ERROR]: WEBPAGE_SUMMARY_EMPTY — No summary returned.";
  } catch (e) {
    await reportError(e, null, "WEBPAGE_SUMMARY_FAIL", "ERROR");
    return `[ERROR]: WEBPAGE_SUMMARY_FAIL — ${e?.message || "Summarization failed."}`;
  }
}

module.exports = { getWebpage };

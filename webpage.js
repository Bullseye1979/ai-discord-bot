// webpage.js — clean v1.3
// Fetches a webpage via Puppeteer, strips UI/noise, returns clean text; optional summarization.

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { getAI } = require("./aiService.js");
const Context = require("./context.js");

puppeteer.use(StealthPlugin());

/** Fetch, clean and optionally summarize a webpage (tool entry). */
async function getWebpage(toolFunction) {
  const args =
    typeof toolFunction.arguments === "string"
      ? JSON.parse(toolFunction.arguments || "{}")
      : (toolFunction.arguments || {});
  const url = String(args.url || "").trim();
  const wantSummary = args.summary === true; // default: return clean text

  if (!url) return "[ERROR]: WEBPAGE_INPUT — Missing 'url'.";

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.8",
      "Sec-Fetch-Mode": "navigate",
    });

    const resp = await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
    if (!resp) return "[ERROR]: WEBPAGE_FETCH — No response received.";

    const status = resp.status();
    const ctype = String(resp.headers()?.["content-type"] || "").toLowerCase();

    if (status >= 400) {
      return `[ERROR]: WEBPAGE_STATUS — HTTP ${status} for ${url}`;
    }

    if (ctype.includes("application/json")) {
      const jsonText = await resp.text();
      if (!jsonText || jsonText.length < 2) return "[ERROR]: WEBPAGE_JSON_EMPTY — Empty JSON body.";
      try {
        const parsed = JSON.parse(jsonText);
        return JSON.stringify(parsed, null, 2);
      } catch {
        return "[ERROR]: WEBPAGE_JSON_PARSE — JSON could not be parsed.";
      }
    }

    if (ctype.includes("text/html") || ctype.includes("application/xhtml+xml")) {
      await page.waitForSelector("main, article, body", { timeout: 15000 }).catch(() => {});
      const { title, text } = await extractReadableText(page);

      const raw = (title ? `${title}\n\n` : "") + text;
      if (!raw || raw.trim().length < 50) {
        const fallback = (await page.evaluate(() => document.body?.innerText || "")).trim();
        if (!fallback || fallback.length < 50) {
          return "[ERROR]: WEBPAGE_CONTENT_EMPTY — Could not extract meaningful text.";
        }
        return wantSummary ? await summarizeText(fallback.slice(0, 120000)) : fallback;
      }

      const clipped = raw.slice(0, 200_000);
      return wantSummary ? await summarizeText(clipped) : clipped;
    }

    const rawOther = await resp.text().catch(() => "");
    return rawOther && rawOther.length
      ? rawOther.slice(0, 4000)
      : "[ERROR]: WEBPAGE_UNSUPPORTED_TYPE — Unsupported content type.";
  } catch (e) {
    return `[ERROR]: WEBPAGE_EXCEPTION — ${e?.message || "Unexpected error."}`;
  } finally {
    try { await browser?.close(); } catch {}
  }
}

/** Extract a page title and readable text from the DOM. */
async function extractReadableText(page) {
  return page.evaluate(() => {
    const remove = [
      "script",
      "style",
      "noscript",
      "iframe",
      "svg",
      "canvas",
      "form",
      "nav",
      "header",
      "footer",
      "aside",
      "picture",
      "video",
      "audio",
      "source",
      "template",
      "link",
      "meta",
      "button",
      "input",
      "select",
      "textarea",
      ".advertisement",
      "[role='navigation']",
      "[aria-hidden='true']",
    ];
    remove.forEach((sel) => document.querySelectorAll(sel).forEach((n) => n.remove()));

    const root = document.querySelector("article") || document.querySelector("main") || document.body;
    const ttl = document.title || "";
    const txt = (root?.innerText || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();

    return { title: ttl, text: txt };
  });
}

/** Summarize text briefly in English (token-efficient). */
async function summarizeText(text) {
  try {
    const ctx = new Context();
    await ctx.add("system", "summarizer", "Summarize the text concisely in English. Keep names, figures, and URLs.");
    await ctx.add("user", "source", text);
    const out = await getAI(ctx, 900, "gpt-4o");
    return out?.trim() || "[ERROR]: WEBPAGE_SUMMARY_EMPTY — No summary returned.";
  } catch (e) {
    return `[ERROR]: WEBPAGE_SUMMARY_FAIL — ${e?.message || "Summarization failed."}`;
  }
}

module.exports = { getWebpage };

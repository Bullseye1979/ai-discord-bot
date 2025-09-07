// webpage.js — v2.0 (generic Q&A on webpages via GPT-4.1)
// Always returns JSON with { result, raw_text, url }.
// - raw_text = full page text without HTML (clipped to MAX_INPUT_CHARS)
// - result   = answer to user_prompt (can be summary, extraction, search, etc.)
// - url      = source URL

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { getAI } = require("./aiService.js");
const Context = require("./context.js");
const { reportError } = require("./error.js");

puppeteer.use(StealthPlugin());

const MAX_INPUT_CHARS = 250_000;
const WEB_MODEL = "gpt-4.1";
const WEB_TOKENS = 1400;

async function getWebpage(toolFunction) {
  let browser;
  try {
    const args =
      typeof toolFunction.arguments === "string"
        ? JSON.parse(toolFunction.arguments || "{}")
        : (toolFunction.arguments || {});

    const url = String(args.url || "").trim();
    const userPrompt = String(args.user_prompt || "").trim();

    if (!url) return JSON.stringify({ error: "WEBPAGE_INPUT — Missing 'url'." });
    if (!userPrompt) return JSON.stringify({ error: "WEBPAGE_NO_PROMPT — Missing 'user_prompt'." });

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
    });

    const resp = await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
    if (!resp) {
      return JSON.stringify({ error: "WEBPAGE_FETCH — No response received." });
    }

    const status = resp.status();
    const ctype = String(resp.headers()?.["content-type"] || "").toLowerCase();
    if (status >= 400) {
      return JSON.stringify({ error: `WEBPAGE_STATUS — HTTP ${status} for ${url}` });
    }

    let textContent = "";

    if (ctype.includes("application/json")) {
      const jsonText = await resp.text();
      textContent = jsonText.slice(0, MAX_INPUT_CHARS);
    } else if (ctype.includes("text/html") || ctype.includes("application/xhtml+xml")) {
      await page.waitForSelector("main, article, body", { timeout: 15000 }).catch(() => {});
      const { title, text } = await extractReadableText(page);
      textContent = ((title ? `${title}\n\n` : "") + text).trim();
      if (!textContent || textContent.length < 50) {
        const fallback = (await page.evaluate(() => document.body?.innerText || "")).trim();
        textContent = fallback;
      }
      textContent = textContent.slice(0, MAX_INPUT_CHARS);
    } else {
      const rawOther = await resp.text().catch(() => "");
      textContent = rawOther.slice(0, MAX_INPUT_CHARS);
    }

    if (!textContent) {
      return JSON.stringify({ error: "WEBPAGE_CONTENT_EMPTY — Could not extract meaningful text." });
    }

    // Run the user prompt against the page text
    const ctx = new Context();
    await ctx.add(
      "system",
      "web_analyst",
      [
        "You are a helpful assistant with a very large context window.",
        "You are given a webpage's plain text (HTML stripped).",
        "Answer the user's request precisely using the page text as source.",
        "Preserve key names, numbers, and URLs if relevant.",
        "Output should directly address the request (can be summary, extraction, search, etc.).",
      ].join(" ")
    );
    await ctx.add("user", "request", `User request: "${userPrompt}"`);
    await ctx.add("user", "page_text", textContent);

    const out = await getAI(ctx, WEB_TOKENS, WEB_MODEL);

    return JSON.stringify({
      result: (out || "").trim(),
      raw_text: textContent,
      url,
    });
  } catch (e) {
    await reportError(e, null, "WEBPAGE_UNHANDLED", "ERROR");
    return JSON.stringify({ error: `WEBPAGE_UNHANDLED — ${e?.message || "Unexpected failure"}` });
  } finally {
    try {
      await browser?.close();
    } catch {}
  }
}

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

module.exports = { getWebpage };

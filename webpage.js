// webpage.js — v2.1 (only result + url)
// Executes the user_prompt against the page text (HTML stripped).
// Returns JSON: { result, url }

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
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );

    const resp = await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
    if (!resp) return JSON.stringify({ error: "WEBPAGE_FETCH — No response received." });

    const status = resp.status();
    if (status >= 400) return JSON.stringify({ error: `WEBPAGE_STATUS — HTTP ${status} for ${url}` });

    const ctype = String(resp.headers()?.["content-type"] || "").toLowerCase();
    let textContent = "";

    if (ctype.includes("text/html") || ctype.includes("application/xhtml+xml")) {
      await page.waitForSelector("main, article, body", { timeout: 15000 }).catch(() => {});
      const { title, text } = await extractReadableText(page);
      textContent = ((title ? `${title}\n\n` : "") + text).trim();
      if (!textContent || textContent.length < 50) {
        const fallback = (await page.evaluate(() => document.body?.innerText || "")).trim();
        textContent = fallback;
      }
    } else {
      const rawOther = await resp.text().catch(() => "");
      textContent = rawOther;
    }

    textContent = textContent.slice(0, MAX_INPUT_CHARS);
    if (!textContent) return JSON.stringify({ error: "WEBPAGE_CONTENT_EMPTY — No text extracted." });

    const ctx = new Context();
    await ctx.add(
      "system",
      "web_analyst",
      [
        "You are a helpful assistant with a very large context window.",
        "You are given a webpage's plain text (HTML stripped).",
        "Answer the user's request precisely using the page text as source.",
        "Preserve key names, numbers, and URLs if relevant.",
      ].join(" ")
    );
    await ctx.add("user", "request", `User request: "${userPrompt}"`);
    await ctx.add("user", "page_text", textContent);

    const out = await getAI(ctx, WEB_TOKENS, WEB_MODEL);

    return JSON.stringify({ result: (out || "").trim(), url });
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

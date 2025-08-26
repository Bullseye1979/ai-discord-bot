// Version 1.0
// Extract information from a webpage

// Requirements

// const puppeteer = require('puppeteer');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require("axios");
const { getAI } = require('./aiService.js');
const Context = require('./context.js');

// Configuration

const MAX_TOKENS_GPT = 16000; 
const SAFETY_MARGIN = 500;

// Functions


// Download a webpage and send them to the summarizer


async function getWebpage(toolFunction) {
  const args = JSON.parse(toolFunction.arguments || "{}");
  const url = String(args.url || "");
  const wantSummary = args.summary !== false; // default: zusammenfassen
  let browser, page;

  try {
    // Stealth aktivieren
    puppeteer.use(StealthPlugin());

    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled"
      ]
    });

    page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      // HTML bevorzugen, nicht JSON
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
      "Sec-Fetch-Mode": "navigate"
    });

    console.log(`[DEBUG] Navigating to ${url}...`);
    const response = await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
    if (!response) return "[ERROR]: No response received (null).";

    const status = response.status();
    const headers = response.headers();
    const contentType = (headers["content-type"] || "").toLowerCase();

    console.log(`[DEBUG] HTTP Status: ${status}`);
    console.log(`[DEBUG] Content-Type: ${contentType}`);

    // PDFs an das PDF-Tool delegieren (oder Hinweis zurückgeben)
    if (contentType.includes("application/pdf")) {
      return "[ERROR]: URL is a PDF. Use getPDF for this link.";
    }

    // JSON direkt zurückgeben (wie bisher)
    if (contentType.includes("application/json")) {
      const jsonText = await response.text();
      if (!jsonText || jsonText.length < 10) return "[ERROR]: JSON response empty.";
      try {
        const parsed = JSON.parse(jsonText);
        return JSON.stringify(parsed, null, 2);
      } catch (e) {
        console.error("[ERROR] Failed to parse JSON:", e.message);
        return "[ERROR]: JSON could not be parsed.";
      }
    }

    // HTML: lesbaren Text extrahieren
    if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
      // Warten, bis Hauptinhalt da ist (best effort)
      await page.waitForSelector("main, article, body", { timeout: 15000 }).catch(() => {});
      const { title, text } = await page.evaluate(() => {
        const kill = ["script","style","noscript","iframe","svg","canvas","form","nav","header","footer","aside","picture"];
        kill.forEach(sel => document.querySelectorAll(sel).forEach(n => n.remove()));
        const root = document.querySelector("article") || document.querySelector("main") || document.body;
        const title = document.title || "";
        const text = (root?.innerText || "")
          .replace(/\u00a0/g, " ")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        return { title, text };
      });

      if (!text || text.length < 50) {
        // Fallback: gesamte Seite als Text
        const fallback = await page.evaluate(() => document.body?.innerText || "");
        if (!fallback || fallback.trim().length < 50) {
          return "[ERROR]: Could not extract meaningful text.";
        }
        if (!wantSummary) return fallback.trim();
        const clipped = fallback.slice(0, 120000); // ~120k chars Kappung
        const summary = await getSummary(clipped);
        return summary || fallback.trim();
      }

      // optional: zusammenfassen
      if (!wantSummary) {
        return `${title ? title + "\n\n" : ""}${text}`;
      }
      const raw = `${title ? title + "\n\n" : ""}${text}`;
      // harte Kappung gegen überlange Seiten
      const clipped = raw.slice(0, 120000);
      const summary = await getSummary(clipped);
      return summary || clipped;
    }

    // Unbekannter Content-Type → roh zurückgeben
    const raw = await response.text().catch(() => "");
    return raw && raw.length ? raw.slice(0, 2000) : "[ERROR]: Unsupported content type.";
  } catch (error) {
    console.error("[ERROR] getWebpage failed:", error);
    return "[ERROR] Unable to process webpage.";
  } finally {
    if (browser) await browser.close();
  }
}




// Summarize the webpage

async function getSummary(text) {
    try {
        const context = new Context();
        context.add("system", null, "Summarize the following text, keep names and links intact, discard only irrelevant information. Store the summary in Mandarin for maximum token efficiency.");
        context.add("user", null, text);
        const aiResponse = await getAI(context, 1000,"gpt-3.5-turbo");
        if (aiResponse) {
            return aiResponse;
        } else {
            return "[ERROR]: No summary returned by GPT.";
        }
    } catch (error) {
        return "[ERROR]: Exception during summarization.";
    }
}


// Exports

module.exports = { getWebpage };

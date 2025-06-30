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
    const args = JSON.parse(toolFunction.arguments);
    const url = args.url;
    let browser;
    let page;

    try {
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
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        );

        // Optional: keine Referer oder Tracking-Header senden
        await page.setExtraHTTPHeaders({
            'Accept': 'application/json',
        });

        console.log(`[DEBUG] Navigating to ${url}...`);

        const response = await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 30000
        });

        if (!response) {
            return "[ERROR]: No response received (null).";
        }

        const status = response.status();
        console.log(`[DEBUG] HTTP Status: ${status}`);

        const headers = response.headers();
        const contentType = headers['content-type'] || '';
        console.log(`[DEBUG] Content-Type: ${contentType}`);

        if (!contentType.includes('application/json')) {
            return `[ERROR]: Unexpected content type: ${contentType}`;
        }

        const jsonText = await response.text();

        if (!jsonText || jsonText.length < 10) {
            return "[ERROR]: Response is empty or too short.";
        }

        try {
            const parsed = JSON.parse(jsonText);
            console.log(`[DEBUG] JSON parsed successfully.`);
            return JSON.stringify(parsed, null, 2); // oder zusammenfassen
        } catch (parseError) {
            console.error("[ERROR] Failed to parse JSON:", parseError.message);
            return "[ERROR]: JSON could not be parsed.";
        }

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

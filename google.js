// google.js — refactored v1.1
// Uses Google Custom Search API to return relevant results.
// Fehlerausgaben laufen über reportError; Channel-Weitergabe optional.

const axios = require("axios");
const { reportError } = require("./error.js");

/**
 * Google-Suche via Custom Search API.
 * Erwartet toolFunction.arguments mit { query, user_id }.
 */
async function getGoogle(toolFunction, _ctx = null, _getAIResponse = null, runtime = {}) {
  try {
    const args =
      typeof toolFunction.arguments === "string"
        ? JSON.parse(toolFunction.arguments || "{}")
        : toolFunction.arguments || {};

    const userId = String(args.user_id || runtime.user_id || "user");
    const query = String(args.query || "").trim();

    if (!process.env.GOOGLE_API_KEY || !process.env.GOOGLE_CSE_ID) {
      return "[ERROR]: GOOGLE_CONFIG — Missing GOOGLE_API_KEY or GOOGLE_CSE_ID.";
    }
    if (!query) {
      return "[ERROR]: GOOGLE_INPUT — Missing 'query'.";
    }

    const response = await axios.get("https://www.googleapis.com/customsearch/v1", {
      params: {
        key: process.env.GOOGLE_API_KEY,
        cx: process.env.GOOGLE_CSE_ID,
        q: query,
        num: 5,
      },
      timeout: 20000,
    });

    const items = Array.isArray(response.data?.items) ? response.data.items : [];
    if (items.length === 0) {
      return "[ERROR]: GOOGLE_EMPTY — No relevant search results found.";
    }

    return items
      .map(
        (it) =>
          `${it.title || "Untitled"}\n${it.snippet || ""}\n${it.link || ""}`.trim()
      )
      .join("\n\n");
  } catch (err) {
    await reportError(err, runtime?.channel || null, "GOOGLE_SEARCH", "ERROR");
    return "[ERROR]: GOOGLE_UNAVAILABLE — Unable to retrieve search results.";
  }
}

module.exports = { getGoogle };

// tools.js — unified history tool v3.1
// - Eine Funktion: getHistory
// - Nimmt optional: keywords[] + window + match_limit
// - Nimmt optional: start/end (Timeframe); fehlt der Timeframe -> gesamte History (mit Chunking)
// - user_prompt ist Pflicht: darauf wird der gesamte Prozess ausgerichtet
// - Liefert einen einzigen finalen Text als Antwort (kein JSON-Objekt), damit das Modell direkt damit arbeiten kann

const { getWebpage } = require("./webpage.js");
const { getImage } = require("./image.js");
const { getGoogle } = require("./google.js");
const { getYoutube } = require("./youtube.js");
const { getImageDescription } = require("./vision.js");
const { getLocation } = require("./location.js");
const { getPDF } = require("./pdf.js");
const { getHistory } = require("./history.js"); // ← vereinheitlicht

// ---- OpenAI tool specs ------------------------------------------------------

const tools = [
  {
    type: "function",
    function: {
      name: "getHistory",
      description:
        "Query the channel’s history from MySQL and answer a user_prompt. " +
        "You may provide keywords (AND matching; with ±window rows around each hit) and/or a timeframe (start/end). " +
        "If no timeframe is provided, the entire history is processed using chunking. " +
        "The tool merges the keyword-focused result and the timeframe/full-history result into ONE final answer.",
      parameters: {
        type: "object",
        properties: {
          // --- Core ---
          user_prompt: { type: "string", description: "Instruction/question to apply to the retrieved history." },

          // --- Keywords block (optional) ---
          keywords: {
            type: "array",
            description: "List of keyword tokens (AND match). Min length per token = 2.",
            items: { type: "string" }
          },
          window: {
            type: "number",
            description: "Rows before and after each keyword match (default 10)."
          },
          match_limit: {
            type: "number",
            description: "Maximum number of keyword matches to expand (default 30)."
          },

          // --- Timeframe block (optional) ---
          start: { type: "string", description: "Inclusive lower bound (MySQL DATETIME or ISO). If omitted with 'end', means open start." },
          end:   { type: "string", description: "Inclusive upper bound (MySQL DATETIME or ISO). If both start/end omitted → full history." },

          // --- Chunking / model tuning (optional) ---
          chunk_rows:  { type: "number", description: "Max rows per chunk (default from env TIMEFRAME_CHUNK_ROWS or 500; min 50)." },
          chunk_chars: { type: "number", description: "Soft cap characters per chunk (default from env TIMEFRAME_CHUNK_CHARS or 15000; min 1000)." },
          model:       { type: "string", description: "LLM for per-chunk and merge steps (default env TIMEFRAME_MODEL or 'gpt-4.1')." },
          max_tokens:  { type: "number", description: "Max tokens for per-chunk and merge steps (default env TIMEFRAME_TOKENS or 1200; min 256)." },

          // --- Diagnostics (optional) ---
          log_hint: { type: "string", description: "Optional free-form string to help identify the call in logs." }
        },
        required: ["user_prompt"]
      }
    }
  },

  // andere Tools unverändert (falls im Channel genutzt)
  {
    type: "function",
    function: {
      name: "getWebpage",
      description:
        "Fetch a webpage, remove menus/ads/scripts/HTML, then EXECUTE the user_prompt against the cleaned text. " +
        "Return only the answer and the source URL (no raw text).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL to fetch and clean." },
          user_id: { type: "string", description: "User ID or display name." },
          user_prompt: { type: "string", description: "Original natural-language user request to run against the page text." }
        },
        required: ["url", "user_id", "user_prompt"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getImage",
      description:
        "Generate a high-quality image from a textual prompt. Default size 1024x1024. Do not call if another tool is already creating this same document.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Core visual description. The tool will add artistic choices." },
          size: {
            type: "string",
            description: "Optional output size; omit if not needed.",
            enum: ["1024x1024", "1792x1024", "1024x1792"]
          },
          user_id: { type: "string", description: "User ID or display name." }
        },
        required: ["prompt", "user_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getGoogle",
      description: "Run a Google search and return relevant results. Use for unknown facts or current topics.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          user_id: { type: "string", description: "User ID or display name." }
        },
        required: ["query", "user_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getYoutube",
      description:
        "Parse YouTube subtitles (CC), EXECUTE the user_prompt directly against the full transcript (no chunking), " +
        "and return only the answer and the video URL. Useful for summaries, quote search, scene extraction, etc.",
      parameters: {
        type: "object",
        properties: {
          video_url: { type: "string", description: "YouTube video URL." },
          user_id: { type: "string", description: "User ID or display name." },
          user_prompt: { type: "string", description: "Original natural-language user request (e.g., summarize, extract quotes, find a scene)." }
        },
        required: ["video_url", "user_id", "user_prompt"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getImageDescription",
      description: "Analyze an image (URL or Discord CDN) and return a detailed description. Required before recreating images.",
      parameters: {
        type: "object",
        properties: {
          image_url: { type: "string", description: "Direct image URL or Discord CDN URL of an uploaded image." },
          user_id: { type: "string", description: "User ID or display name." }
        },
        required: ["image_url", "user_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getLocation",
      description:
        "Handle location tasks: route between locations or place pins without a route. Returns map URL, street-view URL, and text description. Always show both links in the answer.",
      parameters: {
        type: "object",
        properties: {
          locations: {
            type: "array",
            description: "List of locations. For routes, provide at least two; for pins, a single location is allowed.",
            items: { type: "string" }
          },
          user_id: { type: "string", description: "User ID or display name." },
          route: { type: "boolean", description: "true = step-by-step route, false = pins only." }
        },
        required: ["locations", "user_id", "route"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getPDF",
      description:
        "Render a PDF from provided HTML and CSS. " +
        "The CSS defines the design of the PDF. If you do not provide CSS a default style is used. " +
        "Ensure that everything is correctly escaped for JSON",
      parameters: {
        type: "object",
        properties: {
          html: {
            type: "string",
            description: "Full HTML body content (with or without <html>/<body> wrapper). Required."
          },
          css: {
            type: "string",
            description: "Optional stylesheet (a default will be used if omitted)."
          },
          filename: {
            type: "string",
            description: "Optional filename without extension. Will be normalized."
          },
          title: {
            type: "string",
            description: "Optional <title> for the document head."
          },
          user_id: {
            type: "string",
            description: "Optional: User ID or display name (for logging/attribution)."
          }
        },
        required: ["html"]
      }
    }
  }
];

// ---- Runtime registry (implementation functions) ----------------------------

const fullToolRegistry = {
  getHistory,      // ← unified
  getWebpage,
  getImage,
  getGoogle,
  getYoutube,
  getImageDescription,
  getLocation,
  getPDF
};

/** Normalize tool names (aliases + case-insensitive) to the canonical registry key. */
function normalizeToolName(name) {
  if (!name) return "";
  const raw = String(name).trim();
  if (!raw) return "";
  // Legacy aliases (falls noch irgendwo konfiguriert)
  if (raw.toLowerCase() === "gettimeframe") return "getHistory";
  if (raw.toLowerCase() === "getchannelhistory") return "getHistory";

  // Case-insensitive match
  const keys = Object.keys(fullToolRegistry);
  const hit = keys.find((k) => k.toLowerCase() === raw.toLowerCase());
  return hit || raw;
}

/** Build a filtered tool list and callable registry for a given allowlist */
function getToolRegistry(toolNames = []) {
  try {
    if (!Array.isArray(toolNames)) {
      return { tools: [], registry: {} };
    }

    const seen = new Set();
    const wanted = toolNames
      .map((n) => normalizeToolName(n))
      .filter((n) => {
        const key = String(n || "");
        if (!key) return false;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    const availableNames = wanted.filter((n) => !!fullToolRegistry[n]);
    const filteredTools = tools.filter((t) => availableNames.includes(t.function.name));

    const registry = {};
    for (const name of availableNames) registry[name] = fullToolRegistry[name];

    return { tools: filteredTools, registry };
  } catch (err) {
    // Minimal fallback
    return { tools: [], registry: {} };
  }
}

module.exports = { tools, getToolRegistry };

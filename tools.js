// tools.js — search→zoom flow v2.0 (angepasst)
// - getTimeframes: Liefert gemergte Zeitfenster (start/end) für AND-Suchbegriffe.
// - getHistory:    Analysiert einen Timeframe ODER die gesamte History (falls start/end fehlen) via Chunking + LLM.
//
// Rückgaben:
// - getTimeframes: JSON-String { windows: [{start, end, hits, sample}], total_matches }
// - getHistory:    Ein einzelner Text (finale Antwort)
//
// Channel-Scoping und Sicherheitsfilter passieren in history.js (serverseitig).

const { getWebpage } = require("./webpage.js");
const { getImage } = require("./image.js");
const { getGoogle } = require("./google.js");
const { getYoutube } = require("./youtube.js");
const { getImageDescription } = require("./vision.js");
const { getLocation } = require("./location.js");
const { getPDF } = require("./pdf.js");

// ✨ Neu:
const { getTimeframes, getHistory } = require("./history.js");

// ---- OpenAI tool specs ------------------------------------------------------

const tools = [
  // ---- Neu: getTimeframes ---------------------------------------------------
  {
    type: "function",
    function: {
      name: "getTimeframes",
      description:
        "Search the channel history for AND-matched keywords and return MERGED time windows around each hit. " +
        "Use this first to discover relevant time ranges. Then call getHistory with a selected window and a user_prompt.",
      parameters: {
        type: "object",
        properties: {
          keywords: {
            type: "array",
            description: "List of keywords (AND). Min token length = 2.",
            items: { type: "string" }
          },
          around_seconds: {
            type: "number",
            description: "Seconds before/after each hit to expand the window (default 900 = 15 min)."
          },
          merge_gap_seconds: {
            type: "number",
            description: "Merge windows whose gap is <= this value (default 300 = 5 min)."
          },
          match_limit: {
            type: "number",
            description: "Max matched rows to consider/expand (default 100)."
          },
          log_hint: {
            type: "string",
            description: "Optional text to appear in server logs for debugging."
          }
        },
        required: ["keywords"]
      }
    }
  },

  // ---- Neu: getHistory (Timeframe/Full + Chunking) -------------------------
  {
    type: "function",
    function: {
      name: "getHistory",
      description:
        "Analyze a timeframe — or the entire channel if no 'start'/'end' is given — with chunking and return a single final answer. " +
        "Provide a clear user_prompt describing what to extract/summarize from the selected history slice.",
      parameters: {
        type: "object",
        properties: {
          user_prompt: { type: "string", description: "Instruction/question to apply to the selected history slice." },
          start: { type: "string", description: "Inclusive lower bound timestamp (MySQL DATETIME or ISO). Optional." },
          end:   { type: "string", description: "Inclusive upper bound timestamp (MySQL DATETIME or ISO). Optional." },

          // Optional tuning
          chunk_rows:  { type: "number", description: "Max rows per chunk (default env TIMEFRAME_CHUNK_ROWS or 500; min 50)." },
          chunk_chars: { type: "number", description: "Soft cap characters per chunk (default env TIMEFRAME_CHUNK_CHARS or 15000; min 1000)." },
          model:       { type: "string", description: "Model for per-chunk and merge steps (default env TIMEFRAME_MODEL or 'gpt-4.1')." },
          max_tokens:  { type: "number", description: "Max tokens per step (default env TIMEFRAME_TOKENS or 1200; min 256)." },

          log_hint: { type: "string", description: "Optional text to appear in server logs for debugging." }
        },
        required: ["user_prompt"]
      }
    }
  },

  // ---- Bestehende Tools (unverändert) --------------------------------------
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
  // ✨ Neu:
  getTimeframes,
  getHistory,

  // Bestand:
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

  // Case-insensitive match to known keys
  const keys = Object.keys(fullToolRegistry);
  const hit = keys.find((k) => k.toLowerCase() === raw.toLowerCase());
  return hit || raw;
}

/** Build a filtered tool list and callable registry for a given allowlist */
function getToolRegistry(toolNames = []) {
  try {
    if (!Array.isArray(toolNames)) {
      // still return an empty toolset on bad input
      return { tools: [], registry: {} };
    }

    // Normalize names, keep order, drop duplicates
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

    // Warn for unknown tools? (Optional: reportError)
    const availableNames = wanted.filter((n) => !!fullToolRegistry[n]);
    const filteredTools = tools.filter((t) => availableNames.includes(t.function.name));

    // Build callable registry
    const registry = {};
    for (const name of availableNames) {
      registry[name] = fullToolRegistry[name];
    }

    return { tools: filteredTools, registry };
  } catch {
    return { tools: [], registry: {} };
  }
}

module.exports = { tools, getToolRegistry };

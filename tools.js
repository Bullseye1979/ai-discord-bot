// tools.js — smart history v2.3 (getHistory supports frames[])
// - findTimeframes: Keywords -> list of {start,end} windows (channel-scoped), no summarization
// - getHistory: timeframe summarization; accepts EITHER frames[] OR single start/end (or full history)
// - getYoutube: Transcript-QA + metadata
// - getYoutubeSearch: Topic-based YouTube search
// - getToolRegistry() accepts strings or objects (name / function.name / id)

const { getWebpage } = require("./webpage.js");
const { getImage, getImageSD } = require("./image.js");
const { getGoogle } = require("./google.js");
const { getYoutube, getYoutubeSearch } = require("./youtube.js");
const { getImageDescription } = require("./vision.js");
const { getLocation } = require("./location.js");
const { getPDF } = require("./pdf.js");
const { findTimeframes, getHistory } = require("./history.js");
const { reportError } = require("./error.js");

// ---- OpenAI tool specs ------------------------------------------------------

const tools = [
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
        "and return the answer, video URL, and (if possible) metadata (title, channel, publishedAt). " +
        "Useful for summaries, quote search, scene extraction, etc.",
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
      name: "getYoutubeSearch",
      description:
        "Search YouTube for topic-related videos via YouTube Data API v3. Returns compact results (title, channel, publishedAt, URL). " +
        "Use when the user asks for an explanation WITH a video (e.g., 'erkläre mir mit einem Video advantage in dnd').",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search topic or natural-language query." },
          max_results: { type: "number", description: "Max number of results (1-10). Default 5." },
          relevance_language: { type: "string", description: "Hint language for relevance, e.g. 'de', 'en'. Default 'de'." },
          region_code: { type: "string", description: "Region code, e.g. 'DE', 'US'. Default 'DE'." },
          safe_search: { type: "string", description: "none | moderate | strict. Default 'none'." },
          user_id: { type: "string", description: "User ID or display name." }
        },
        required: ["query", "user_id"]
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
        "Handle location tasks: route between locations or place pins without a route. Returns map URL, street-view URL, URL of an image of the destination and text description.",
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

  // ==== History (smart) ======================================================
  {
    type: "function",
    function: {
      name: "findTimeframes",
      description:
        "Find relevant timeframes in THIS Discord channel by AND-matching the provided keywords on message content, " +
        "DO NOT USE THIS, WHEN THE TIMEFRAME ALREADY KNOWN,"+
        "DO NOT USE THIS, WHEN THE TIME OR DATE ON WHICH TO SEARCH IS SPECIFIED,"+
        "TRY TO AVOID USING THIS FUNCTION! ONLY USE IT WHEN REALLY NEEDED ! "+
        "ONLY USE THIS FOR KEYWORD SEARCHES (e.g. when you search for a specific person or event, or if you want to answer a specific question)." +
        "then expanding each hit to a window of ±N rows (same channel). Returns JSON with merged {start,end} ISO timestamps for each timeframe. " +
        "Use this to locate episodes (e.g., an arc with 'murphy'), then call getHistory with one or multiple returned timeframes.",
      parameters: {
        type: "object",
        properties: {
          keywords: {
            type: "array",
            description: "Keywords to AND-match (min length per token = 2). Example: ['murphy','vampir']",
            items: { type: "string" }
          },
          window: {
            type: "number",
            description: "Rows before and after each match to include in the timeframe (default 30)."
          },
          channel_id: { type: "string", description: "Channel ID (injected by runtime if omitted)." }
        },
        required: ["keywords"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getHistory",
      description:
        "Summarize THIS Discord channel over one or MULTIPLE timeframes using a single LLM pass (no chunking). " +
        "Provide a 'user_prompt' that states exactly what to produce. " +
        "USE THIS WITHOUT findTimeframes WHEN THE TIMEFRAME IS ALREADY KNOWN,"+
        "Prefer 'frames' from findTimeframes; alternatively provide a single 'start'/'end'. " +
        "If neither frames nor start/end are provided, the FULL channel history is used (be precise!).",
      parameters: {
        type: "object",
        properties: {
          user_prompt: { type: "string", description: "Exact natural-language instruction for the summarization (required)." },
          frames: {
            type: "array",
            description: "List of timeframes with ISO timestamps (use output from findTimeframes).",
            items: {
              type: "object",
              properties: {
                start: { type: "string", description: "ISO timestamp (inclusive)" },
                end:   { type: "string", description: "ISO timestamp (inclusive)" }
              },
              required: ["start", "end"]
            }
          },
          start: { type: "string", description: "ISO timestamp (inclusive) — optional if frames[] provided." },
          end: { type: "string", description: "ISO timestamp (inclusive) — optional if frames[] provided." },
          model: { type: "string", description: "Optional model override (default gpt-4.1 via aiService.js)." },
          max_tokens: { type: "number", description: "Optional max output tokens (default from aiService.js)." },
          channel_id: { type: "string", description: "Channel ID (injected by runtime if omitted)." }
        },
        required: ["user_prompt"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getImageSD",
      description:
        "Generate an image via Stable Diffusion (Automatic1111 if SD_BASE_URL is set; otherwise Stability AI if STABILITY_API_KEY exists). " +
        "The image is stored locally and a public URL is returned.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Visual prompt." },
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

  // ==== getPDF (unchanged) ===================================================
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

// ---- Runtime registry -------------------------------------------------------

const fullToolRegistry = {
  getWebpage,
  getImage,
  getGoogle,
  getYoutube,
  getYoutubeSearch,
  getImageDescription,
  getLocation,
  getPDF,
  getImageSD,
  findTimeframes,
  getHistory
};

/** Normalize tool names (aliases + case-insensitive) to the canonical registry key. */
function normalizeToolName(name) {
  if (!name) return "";
  const raw = String(name).trim();
  if (!raw) return "";

  // Aliases
  if (raw.toLowerCase() === "findtimeframes") return "findTimeframes";
  if (raw.toLowerCase() === "gethistory") return "getHistory";

  // Case-insensitive match
  const keys = Object.keys(fullToolRegistry);
  const hit = keys.find((k) => k.toLowerCase() === raw.toLowerCase());
  return hit || raw;
}

/** Robust: accepts strings or objects and extracts the desired name. */
function extractToolName(item) {
  try {
    if (typeof item === "string") return item.trim();
    if (item && typeof item === "object") {
      const n =
        item.name ||
        (item.function && item.function.name) ||
        item.id ||
        "";
      return String(n).trim();
    }
    return "";
  } catch {
    return "";
  }
}

/** Build a filtered tool list and callable registry for a given allowlist */
function getToolRegistry(toolNames = []) {
  try {
    if (!Array.isArray(toolNames)) {
      reportError(new Error("toolNames must be an array"), null, "GET_TOOL_REGISTRY_BAD_INPUT", "WARN");
      return { tools: [], registry: {} };
    }

    // 1) Normalize inputs: strings/objects → names
    const normalizedRequested = toolNames
      .map(extractToolName)
      .filter(Boolean);

    // 2) Canonical names, keep order, dedupe
    const seen = new Set();
    const wanted = normalizedRequested
      .map((n) => normalizeToolName(n))
      .filter((n) => {
        const key = String(n || "");
        if (!key) return false;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    // 3) Warn unknown
    for (const name of wanted) {
      if (!fullToolRegistry[name]) {
        reportError(new Error(`Unknown tool '${name}'`), null, "GET_TOOL_REGISTRY_UNKNOWN", "WARN");
      }
    }

    // 4) Filter to known tools
    const availableNames = wanted.filter((n) => !!fullToolRegistry[n]);

    // 5) OpenAI tool specs filtered by name
    const filteredTools = tools.filter((t) => availableNames.includes(t.function.name));

    // 6) Callable registry
    const registry = {};
    for (const name of availableNames) {
      registry[name] = fullToolRegistry[name];
    }

    return { tools: filteredTools, registry };
  } catch (err) {
    reportError(err, null, "GET_TOOL_REGISTRY", "ERROR");
    return { tools: [], registry: {} };
  }
}

module.exports = { tools, getToolRegistry };

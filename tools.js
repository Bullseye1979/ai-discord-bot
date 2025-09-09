// tools.js — refactored v1.9
// - getWebpage: requires user_prompt, returns only { result, url }
// - getYoutube: user_prompt-driven transcript Q&A (no chunking), returns only { result, video_url }
// - getHistory: modes (raw | passthrough | qa); channel/order enforced in code

const { getWebpage } = require("./webpage.js");
const { getImage } = require("./image.js");
const { getGoogle } = require("./google.js");
const { getYoutube } = require("./youtube.js");
const { getImageDescription } = require("./vision.js");
const { getLocation } = require("./location.js");
const { getPDF } = require("./pdf.js");
const { getHistory } = require("./history.js");
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

  // ==== getHistory: modes (raw | passthrough | qa); channel filter & ORDER BY enforced in code ====
  {
    type: "function",
    function: {
      name: "getHistory",
      description:
        "Query the channel’s history with one of three modes: " +
        "`raw` returns exact DB rows (no AI; preserves summaries 1:1); " +
        "`passthrough` returns a single concatenated text block (no AI; for direct context dump); " +
        "`qa` performs keyword matching plus channel-safe context windows (±10 around each match, same channel), " +
        "deduplicates, and returns an AI-crafted answer. " +
        "When asked for summaries, use passthrough on the summaries table"+
        "Channel scoping and ORDER BY are always injected by the runtime; the model must NOT build full SQL.",
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["raw", "passthrough", "qa"],
            description: "raw = exact rows; passthrough = single text block; qa = KI-gestützte Antwort"
          },
          channel_id: { type: "string", description: "Target channel identifier. Required." },
          user_id: { type: "string", description: "Optional: User ID or display name (for logging/attribution)." },

          // Common filters for raw/passthrough (optional)
          limit: { type: "number", description: "Optional max rows for raw/passthrough modes (default enforced server-side)." },
          time_from: { type: "string", description: "Optional ISO timestamp lower bound (raw/passthrough)." },
          time_to: { type: "string", description: "Optional ISO timestamp upper bound (raw/passthrough)." },
          query: {
            type: "string",
            description:
              "Optional keyword string. In qa it is REQUIRED and used to locate matches; " +
              "in raw/passthrough it broadens filtering (in addition to time/limit)."
          }
        },
        required: ["mode", "channel_id"]
      }
    }
  },

  // ==== getPDF (unverändert; CSS optional laut aktuellem Contract) ====
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
  getWebpage,
  getImage,
  getGoogle,
  getYoutube,
  getImageDescription,
  getLocation,
  getPDF,
  getHistory
};

/** Normalize tool names (aliases + case-insensitive) to the canonical registry key. */
function normalizeToolName(name) {
  if (!name) return "";
  const raw = String(name).trim();
  if (!raw) return "";

  // Quick alias
  if (raw.toLowerCase() === "gethistory") return "getHistory";

  // Case-insensitive match to known keys
  const keys = Object.keys(fullToolRegistry);
  const hit = keys.find((k) => k.toLowerCase() === raw.toLowerCase());
  return hit || raw;
}

/** Build a filtered tool list and callable registry for a given allowlist */
function getToolRegistry(toolNames = []) {
  try {
    if (!Array.isArray(toolNames)) {
      reportError(new Error("toolNames must be an array"), null, "GET_TOOL_REGISTRY_BAD_INPUT", "WARN");
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

    // Warn for unknown tools
    for (const name of wanted) {
      if (!fullToolRegistry[name]) {
        reportError(new Error(`Unknown tool '${name}'`), null, "GET_TOOL_REGISTRY_UNKNOWN", "WARN");
      }
    }

    // Filter OpenAI tool specs to requested/available set
    const availableNames = wanted.filter((n) => !!fullToolRegistry[n]);
    const filteredTools = tools.filter((t) => availableNames.includes(t.function.name));

    // Build callable registry
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

// tools.js — refactored v2.0
// - getHistory: Keyword-AND über Einzelzeilen + ±window im selben Channel -> Digest mit Timestamps (Text).
//               Wenn keine Treffer: "NO_MATCHES: getTimeframe is recommended for broad summaries."
// - getTimeframe: Für Recaps/Stories/Übersichten. Ohne start/end wird die GESAMTE History des Channels analysiert
//                 (Notfall-Chunking + Merge). Erwartet einen user_prompt, der auf die Daten angewendet wird.
// - Tool-Beschreibungen so formuliert, dass die Modell-Policy ohne extra Priming gut funktioniert.

const { getWebpage } = require("./webpage.js");
const { getImage } = require("./image.js");
const { getGoogle } = require("./google.js");
const { getYoutube } = require("./youtube.js");
const { getImageDescription } = require("./vision.js");
const { getLocation } = require("./location.js");
const { getPDF } = require("./pdf.js");
const { getHistory, getTimeframe } = require("./history.js");
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

  // ==== Channel history tools ====
  {
    type: "function",
    function: {
      name: "getHistory",
      description:
        "Perefer getTimeframe before this function to solve the task. This function should only be used to get information about specific persons, items, events, locations, names. Do not use if for summaries."+
        "Keyword-based lookup over single rows (AND across keywords, same row) within THIS channel; " +
        "returns a digest with timestamps plus ±window context around each match. " +
        "Use for pinpoint retrieval with 1–3 distinctive terms (names, quest titles). " +
        "NOT for whole-channel recaps. " +
        "If this returns 'NO_MATCHES: …' or the digest is too small, immediately call getTimeframe with the original user instruction.",
      parameters: {
        type: "object",
        properties: {
          keywords: {
            type: "array",
            items: { type: "string" },
            description: "Distinctive search tokens (AND-matched per single row). Use 1–3 strong terms."
          },
          window: { type: "number", description: "±N rows of surrounding context per match (default 10)." },
          match_limit: { type: "number", description: "Max matching rows to expand (default 30)." }
        },
        required: ["keywords"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getTimeframe",
      description:
        "For broad recaps/overviews/stories: applies the user_prompt to channel history with emergency chunking. " +
        "If start/end are omitted, scans the FULL channel history. " +
        "Use this when asked to 'summarize/recap/story/what happened' or when getHistory produced no/low-yield results.",
      parameters: {
        type: "object",
        properties: {
          user_prompt: { type: "string", description: "Instruction to execute against the history (e.g., 'Summarize the campaign story')." },
          start: { type: "string", description: "Optional ISO timestamp lower bound; omit to include from the beginning." },
          end: { type: "string", description: "Optional ISO timestamp upper bound; omit to include up to now." },
          chunk_chars: { type: "number", description: "Optional emergency chunk cap (characters per chunk; default from ENV or 15000)." },
          chunk_rows: { type: "number", description: "Optional emergency chunk cap (rows per chunk; default from ENV or 500)." },
          model: { type: "string", description: "Optional LLM for chunk analysis/merge (default ENV TIMEFRAME_MODEL or gpt-4.1)." },
          max_tokens: { type: "number", description: "Optional token cap per chunk (default ENV TIMEFRAME_TOKENS or 1200)." }
        },
        required: ["user_prompt"]
      }
    }
  },

  // ==== getPDF (unverändert) ====
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
  getHistory,
  getTimeframe
};

/** Normalize tool names (aliases + case-insensitive) to the canonical registry key. */
function normalizeToolName(name) {
  if (!name) return "";
  const raw = String(name).trim();
  if (!raw) return "";

  if (raw.toLowerCase() === "gethistory") return "getHistory";
  if (raw.toLowerCase() === "gettimeframe") return "getTimeframe";

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

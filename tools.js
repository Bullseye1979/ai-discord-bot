// tools.js — refactored v1.4 (structured getHistory + name normalization)

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
      description: "Fetch a webpage, remove menus/ads/scripts/HTML, and return cleaned text.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL to fetch and clean." },
          user_id: { type: "string", description: "User ID or display name." }
        },
        required: ["url", "user_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getImage",
      description: "Generate a high-quality image from a textual prompt. Default size 1024x1024. Do not call if another tool is already creating this same document.",
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
      description: "Parse YouTube subtitles, summarize, and return timestamped blocks. Applies the user prompt per block.",
      parameters: {
        type: "object",
        properties: {
          video_url: { type: "string", description: "YouTube video URL." },
          user_id: { type: "string", description: "User ID or display name." },
          user_prompt: { type: "string", description: "Original natural-language user request." }
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
      description: "Handle location tasks: route between locations or place pins without a route. Returns map URL, street-view URL, and text description. Always show both links in the answer.",
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

  // ==== CHANGED: getHistory now expects structured parts instead of full SQL ====
  {
    type: "function",
    function: {
      name: "getHistory",
      description:
        "Query the channel’s history (read-only). Provide mariadb-compatible SQL *parts* only and NOT a full query. " +
        "Allowed table: `context_log` or `summaries` (optionally with alias like `context_log cl`). " +
        "Allowed columns in summaries: timestamp, summary "+
        "Allowed columns in context_log: timestamp, role, sender, content "+
        "Required columns: timestamp always has to be included. "+
        "The channel filter and ORDER BY timestamp are auto-injected. "+
        "Try to restrict the results as less as possible (all messages from a timeframe are better than missing something because of too restrictive WHERE clauses), noise is ok as the result is filtered by AI . Use search parameters that bring as much results as possible for a topic. Take care of different spellings, synonyms or even languages.",
      parameters: {
        type: "object",
        properties: {
          select: {
            type: "string",
            description:
              "Columns/expressions to select, e.g. timestamp, role, sender, content` or `COUNT(*) AS cnt`. Use a mariadb-compatible format"
          },
          from: {
            description:
              "One allowed table (optionally with alias). Use only `context_log` or `summaries`. Example: `context_log` or `summaries s`.",
            oneOf: [
              {
                type: "string",
                enum: ["context_log", "summaries", "context_log cl", "summaries s"]
              },
              {
                type: "array",
                items: {
                  type: "string",
                  enum: ["context_log", "summaries"]
                },
                minItems: 1,
                maxItems: 1
              }
            ]
          },
          where: {
            type: "string",
            description:
              "Optional WHERE predicates (without channel filter, ORDER BY, or LIMIT). Use mariadb-compatible syntax. Always just search for nouns, never for verbs or adjectives." +
              "Examples: `timestamp >= :sinceTs AND role = 'user'`."
          },
          bindings: {
            type: "object",
            description:
              "Named parameters referenced in `where` (e.g. `{ \"sinceTs\": 1716400000000 }`).",
            additionalProperties: { anyOf: [{ type: "string" }, { type: "number" }] }
          }
        },
        required: ["select", "from"],
        additionalProperties: false
      }
    }
  },

  {
    type: "function",
    function: {
      name: "getPDF",
      description: "Create a fully formatted PDF directly from the user's request. This must be the first and only tool call for PDF generation; it manages image generation and rendering internally.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Full instructions for the PDF." },
          original_prompt: { type: "string", description: "Original natural-language user request." },
          user_id: { type: "string", description: "User ID or display name." }
        },
        required: ["prompt", "original_prompt", "user_id"]
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

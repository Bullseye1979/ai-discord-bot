// tools.js — simplified v2.3
// - Alle bisherigen Tools (Webpage, Image, Google, Youtube, Vision, Location, PDF).
// - getHistory (keyword-basierte Suche + Kontextfenster, liefert Digest mit Timestamps).
// - getTimeframe (Zeitfenster ODER gesamte History; Notfall-Chunking; Prompt pro Chunk; Merge).
// - Keine Summary-Sonderfälle.

const { getWebpage } = require("./webpage.js");
const { getImage } = require("./image.js");
const { getGoogle } = require("./google.js");
const { getYoutube } = require("./youtube.js");
const { getImageDescription } = require("./vision.js");
const { getLocation } = require("./location.js");
const { getPDF } = require("./pdf.js");
const { getHistory, getTimeframe } = require("./history.js");

// ---- OpenAI Tool-Spezifikationen -------------------------------------------

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

  // ==== getHistory (Keywords + Kontextfenster; Digest mit Timestamps) ====
  {
    type: "function",
    function: {
      name: "getHistory",
      description:
        "Fetch channel chat history snippets by KEYWORDS and return a digest of matching lines plus ±window surrounding lines (same channel). " +
        "Always returns lines with timestamps so you can later zoom in with getTimeframe. " +
        "Use this when you need quick evidence around specific keywords.",
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string", description: "Target channel ID. If omitted, runtime/ctx channel is used." },
          keywords: {
            type: "array",
            description: "Keywords for AND-matching against message content (case-insensitive).",
            items: { type: "string" }
          },
          window: {
            type: "number",
            description: "Number of surrounding rows before/after each match to include (default 10)."
          },
          match_limit: {
            type: "number",
            description: "Max number of distinct matches to consider before expanding windows (default 30)."
          }
        },
        required: ["keywords"]
      }
    }
  },

  // ==== getTimeframe (Zeitfenster ODER ganze History; Notfall-Chunking) ====
  {
    type: "function",
    function: {
      name: "getTimeframe",
      description:
        "Fetch rows within a time range (start..end) OR the entire channel history if start/end are omitted, and APPLY the provided user_prompt. " +
        "Uses emergency chunking: splits the dataset into manageable chunks, runs the prompt per chunk, then merges into a final answer.",
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string", description: "Target channel ID. If omitted, runtime/ctx channel is used." },
          start: { type: "string", description: "Optional start timestamp (ISO/MySQL DATETIME). Omit for full history." },
          end: { type: "string", description: "Optional end timestamp (ISO/MySQL DATETIME). Omit for full history." },
          user_prompt: { type: "string", description: "What you want extracted/summarized from the timeframe or whole history." },
          // Optional tuning:
          chunk_chars: { type: "number", description: "Soft char cap per chunk (default from env or 15000)." },
          chunk_rows: { type: "number", description: "Soft row cap per chunk (default from env or 500)." },
          model: { type: "string", description: "Optional model override for chunk analysis (default gpt-4.1)." },
          max_tokens: { type: "number", description: "Optional max tokens per chunk analysis (default 1200)." }
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

// ---- Laufzeit-Registry (Implementierungen) ----------------------------------

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

/** Normalisiert Tool-Namen (Alias + Case-insensitive) zur Registry-Key-Form. */
function normalizeToolName(name) {
  if (!name) return "";
  const raw = String(name).trim();
  if (!raw) return "";

  const lower = raw.toLowerCase();
  if (lower === "gethistory") return "getHistory";
  if (lower === "gettimeframe") return "getTimeframe";

  const keys = Object.keys(fullToolRegistry);
  const hit = keys.find((k) => k.toLowerCase() === lower);
  return hit || raw;
}

/** Baut gefilterte Tool-Liste + callable Registry für eine Allowlist. */
function getToolRegistry(toolNames = []) {
  try {
    if (!Array.isArray(toolNames)) {
      console.warn("[GET_TOOL_REGISTRY] toolNames must be an array");
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

    for (const name of wanted) {
      if (!fullToolRegistry[name]) {
        console.warn(`[GET_TOOL_REGISTRY] Unknown tool '${name}'`);
      }
    }

    const availableNames = wanted.filter((n) => !!fullToolRegistry[n]);
    const filteredTools = tools.filter((t) => availableNames.includes(t.function.name));

    const registry = {};
    for (const name of availableNames) {
      registry[name] = fullToolRegistry[name];
    }

    return { tools: filteredTools, registry };
  } catch (err) {
    console.error("[GET_TOOL_REGISTRY] ERROR:", err?.message || err);
    return { tools: [], registry: {} };
  }
}

module.exports = { tools, getToolRegistry };

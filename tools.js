// tools.js — clean v1.2

const { getWebpage } = require("./webpage.js");
const { getImage } = require("./image.js");
const { getGoogle } = require("./google.js");
const { getYoutube } = require("./youtube.js");
const { getImageDescription } = require("./vision.js");
const { getLocation } = require("./location.js");
const { getPDF } = require("./pdf.js");
const { getHistory } = require("./history.js");

const tools = [
  {
    type: "function",
    function: {
      name: "getWebpage",
      description:
        "Fetch a webpage, remove menus/ads/scripts/HTML, and return cleaned text.",
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
      description:
        "Generate a high-quality image from a textual prompt. Default size 1024x1024. Do not call if another tool is already creating this same document.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "Core visual description. The tool will add artistic choices."
          },
          size: {
            type: "string",
            description:
              "Optional output size; omit if not needed.",
            enum: ["1024x1024", "1792x1024", "1024x1792"]
          },
          user_id: {
            type: "string",
            description: "User ID or display name."
          }
        },
        required: ["prompt", "user_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getGoogle",
      description:
        "Run a Google search and return relevant results. Use for unknown facts or current topics.",
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
        "Parse YouTube subtitles, summarize, and return timestamped blocks. Applies the user prompt per block.",
      parameters: {
        type: "object",
        properties: {
          video_url: { type: "string", description: "YouTube video URL." },
          user_id: { type: "string", description: "User ID or display name." },
          user_prompt: { type: "string", description: "Original user prompt." }
        },
        required: ["video_url", "user_id", "user_prompt"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getImageDescription",
      description:
        "Analyze an image (URL or Discord CDN) and return a detailed description. Required before recreating images.",
      parameters: {
        type: "object",
        properties: {
          image_url: {
            type: "string",
            description:
              "Direct image URL or Discord CDN URL of an uploaded image."
          },
          user_id: {
            type: "string",
            description: "User ID or display name."
          }
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
            description:
              "List of locations. For routes, provide at least two; for pins, a single location is allowed.",
            items: { type: "string" }
          },
          user_id: {
            type: "string",
            description: "User ID or display name."
          },
          route: {
            type: "boolean",
            description:
              "true = step-by-step route, false = pins only."
          }
        },
        required: ["locations", "user_id", "route"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getHistory",
      description:
        "Run a READ-ONLY MySQL SELECT over this channel’s history. The model must write the full SELECT. Allowed tables: context_log(id,timestamp,channel_id,role,sender,content) and summaries(id,timestamp,channel_id,summary,last_context_id). Always include a WHERE with :channel_id.",
      parameters: {
        type: "object",
        properties: {
          channel_id: {
            type: "string",
            description: "Discord channel ID scope."
          },
          sql: {
            type: "string",
            description:
              "Single SELECT statement using MySQL + named placeholders (e.g., :channel_id, :day, :from, :to, :who, :kw, :year)."
          },
          bindings: {
            type: "object",
            description:
              "Values for named placeholders (except channel_id if given top-level).",
            additionalProperties: { anyOf: [{ type: "string" }, { type: "number" }] }
          }
        },
        required: ["sql", "channel_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getPDF",
      description:
        "Create a fully formatted PDF directly from the user's request. This must be the first and only tool call for PDF generation; it manages image generation and rendering internally.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Full instructions for the PDF." },
          original_prompt: {
            type: "string",
            description: "Original natural-language user request."
          },
          user_id: { type: "string", description: "User ID or display name." }
        },
        required: ["prompt", "original_prompt", "user_id"]
      }
    }
  }
];

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

/** Build a filtered tool list and callable registry for a given allowlist */
function getToolRegistry(toolNames = []) {
  if (!Array.isArray(toolNames)) {
    throw new Error("getToolRegistry expects an array of tool names.");
  }
  const filteredTools = tools.filter((t) => toolNames.includes(t.function.name));
  const registry = {};
  for (const name of toolNames) {
    if (fullToolRegistry[name]) registry[name] = fullToolRegistry[name];
  }
  return { tools: filteredTools, registry };
}

module.exports = { tools, getToolRegistry };

// tools.js — smart history v2.9 (+ Confluence JSON Proxy, Space Restriction, Few-Shot Examples)
// - getInformation: OR-keyword search in CURRENT CHANNEL → MESSAGE CONTEXT
// - getHistory: timeframe summarization (single LLM pass)
// - + getWebpage, getImage, getGoogle, getYoutube, getYoutubeSearch,
//     getImageDescription, getLocation, getImageSD, getPDF
// - Confluence: confluencePage as a GENERIC JSON PROXY (space restriction enabled by default)
//   * The model provides a JSON object (HTTP request); we forward it 1:1 to Confluence
//   * Credentials (baseUrl, email, token, defaultSpace, defaultParentId) from channel-config/<channelId>.json
//   * Default: requests are restricted to defaultSpace (Create enforces space.key,
//     Search gets CQL prefix space="KEY", Update/Delete are pre-validated).
//     Override possible via json.meta.allowCrossSpace === true.

const { getWebpage } = require("./webpage.js");
const { getImage, getImageSD } = require("./image.js");
const { getGoogle } = require("./google.js");
const { getYoutube, getYoutubeSearch } = require("./youtube.js");
const { getImageDescription } = require("./vision.js");
const { getLocation } = require("./location.js");
const { getPDF } = require("./pdf.js");
const { getInformation, getHistory } = require("./history.js");
const { reportError } = require("./error.js");

// Confluence (JSON Proxy)
const { confluencePage } = require("./confluence.js");

// ---- OpenAI tool specs ------------------------------------------------------

const tools = [
  // ==== Web ====
  {
    type: "function",
    function: {
      name: "getWebpage",
      description:
        "Fetch a webpage, remove menus/ads/scripts/HTML, then EXECUTE the user_prompt against the cleaned text. " +
        "Return only the answer and the source URL (no raw page dump).",
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

  // ==== Images / Search ====
  {
    type: "function",
    function: {
      name: "getImage",
      description:
        "Generate a high-quality image from a textual prompt. Default size 1024x1024. Do not call if another tool is already creating the same document.",
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

  // ==== YouTube ====
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
        "Use when the user asks for an explanation WITH a video (e.g., 'explain advantage in DnD with a video').",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search topic or natural-language query." },
          max_results: { type: "number", description: "Max number of results (1-10). Default 5." },
          relevance_language: { type: "string", description: "Hint language for relevance, e.g., 'de', 'en'. Default 'de'." },
          region_code: { type: "string", description: "Region code, e.g., 'DE', 'US'. Default 'DE'." },
          safe_search: { type: "string", description: "none | moderate | strict. Default 'none'." },
          user_id: { type: "string", description: "User ID or display name." }
        },
        required: ["query", "user_id"]
      }
    }
  },

  // ==== Vision / Location ====
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

  // ==== History (focused split: lookup vs. summarize) =======================
  {
    type: "function",
    function: {
      name: "getInformation",
      description:
        "Locate relevant messages in THIS Discord channel by OR-matching the provided keywords on message content. " +
        "Always take ONLY the 30 newest hits (ORDER BY id DESC LIMIT 30). " +
        "For each hit, include N rows before and after (default 10), strictly within the same channel. " +
        "Return a flat, deduplicated, id-ascending list of { sender, timestamp(ISO), content }. " +
        "This tool is for quick context lookup/snippets — it does NOT summarize. " +
        "If the user provides an explicit timeframe (dates/times), call getHistory directly instead.",
      parameters: {
        type: "object",
        properties: {
          keywords: {
            type: "array",
            description: "Keywords to OR-match (min token length 2). Example: ['murphy','vampire']",
            items: { type: "string" }
          },
          window: {
            type: "number",
            description: "Rows before and after each hit to include (default 10)."
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
        "Provide a 'user_prompt' that states exactly what to produce (e.g., narrative summary, decision log, action items). " +
        "Prefer 'frames' discovered previously; otherwise provide a single 'start'/'end'. " +
        "If neither frames nor start/end are provided, the FULL channel history is used (be precise!).",
      parameters: {
        type: "object",
        properties: {
          user_prompt: { type: "string", description: "Exact natural-language instruction for the summarization (required)." },
          frames: {
            type: "array",
            description: "List of timeframes with ISO timestamps.",
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
          end:   { type: "string", description: "ISO timestamp (inclusive) — optional if frames[] provided." },
          model: { type: "string", description: "Optional model override (default gpt-4.1 via aiService.js)." },
          max_tokens: { type: "number", description: "Optional max output tokens (default from aiService.js)." },
          channel_id: { type: "string", description: "Channel ID (injected by runtime if omitted)." }
        },
        required: ["user_prompt"]
      }
    }
  },

  // ==== Image (SD) / PDF ====
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
  {
    type: "function",
    function: {
      name: "getPDF",
      description:
        "Render a PDF from provided HTML and CSS. The CSS defines the design. If CSS is missing, a default style is used. " +
        "Ensure that everything is correctly escaped for JSON.",
      parameters: {
        type: "object",
        properties: {
          html: { type: "string", description: "Full HTML body content (with or without <html>/<body> wrapper). Required." },
          css: { type: "string", description: "Optional stylesheet (a default will be used if omitted)." },
          filename: { type: "string", description: "Optional filename without extension. Will be normalized." },
          title: { type: "string", description: "Optional <title> for the document head." },
          user_id: { type: "string", description: "Optional: User ID or display name (for logging/attribution)." }
        },
        required: ["html"]
      }
    }
  },

  // ==== Confluence (JSON Proxy) =============================================
  {
    type: "function",
    function: {
      name: "confluencePage",
      description:
        "Generic JSON proxy to Confluence Cloud REST API. The assistant MUST provide a single 'json' object with HTTP request parameters. " +
        "USE THIS FOR ANY REQUEST OR ACCESS TO CONFLUENCE. DO NOT USE OTHER TOOLCALLS TO TRY TO ACCESS CONFLUENCE. " +
        "This tool forwards the request 1:1 to Confluence (auth & baseUrl are injected from channel-config). " +
        "It might be required to run this tool 2 times, once to get the page-ID from the description and a second time to perform the actual action on this page. " +
        "Space restriction is ON by default:\n" +
        "• POST /rest/api/content → enforce defaultSpace (and defaultParent if available) unless meta.allowCrossSpace===true.\n" +
        "• GET /rest/api/content/search → prepend CQL with space=\"KEY\" unless allowCrossSpace.\n" +
        "• PUT/DELETE by pageId → validate page belongs to KEY unless allowCrossSpace.\n\n" +
        "EXAMPLES (the assistant MUST mirror these patterns exactly):\n" +
        "1) CREATE PAGE\n" +
        "{ \"json\": { \"method\":\"POST\", \"path\":\"/rest/api/content\", \"body\":{ \"type\":\"page\", \"title\":\"Session 3\", \"space\":{ \"key\":\"\" }, \"body\":{ \"storage\":{ \"value\":\"<p>Notes</p>\", \"representation\":\"storage\" } } }, \"meta\":{ \"injectDefaultSpace\":true, \"injectDefaultParent\":true } } }\n" +
        "2) SEARCH PAGES IN SPACE (CQL)\n" +
        "{ \"json\": { \"method\":\"GET\", \"path\":\"/rest/api/content/search\", \"query\":{ \"cql\":\"type=page AND title ~ \\\"Session\\\"\", \"limit\":25 } } }\n" +
        "3) UPLOAD ATTACHMENT TO PAGE\n" +
        "{ \"json\": { \"method\":\"POST\", \"path\":\"/rest/api/content/12345/child/attachment\", \"multipart\":true, \"headers\":{ \"X-Atlassian-Token\":\"no-check\" }, \"files\":[{ \"name\":\"file\", \"url\":\"https://…/img.png\", \"filename\":\"img.png\" }], \"form\":{ \"comment\":\"Upload via bot\" } } }\n" +
        "*Please note that 12345 is a pageID, not a title.*\n" +
        "4) UPDATE PAGE STORAGE\n" +
        "{ \"json\": { \"method\":\"PUT\", \"path\":\"/rest/api/content/12345\", \"body\":{ \"id\":\"12345\", \"type\":\"page\", \"title\":\"Session 3\", \"version\":{ \"number\": 2 }, \"body\":{ \"storage\":{ \"value\":\"<p>Updated</p>\", \"representation\":\"storage\" } } }, \"meta\":{ \"autoBumpVersion\":true } } }\n" +
        "5) APPEND STORAGE HTML (e.g., embed an image macro) + auto version bump\n" +
        "{ \"json\": { \"method\":\"PUT\", \"path\":\"/rest/api/content/12345\", \"body\":{ \"id\":\"12345\", \"type\":\"page\", \"title\":\"Session 3\" }, \"meta\":{ \"appendStorageHtml\":\"<p>…HTML…</p>\", \"autoBumpVersion\":true } } }",
      parameters: {
        type: "object",
        properties: {
          json: {
            type: "object",
            description:
              "HTTP request definition for Confluence. See the examples in the description.",
            properties: {
              method: { type: "string", description: "HTTP method (GET|POST|PUT|DELETE|PATCH). Default GET." },
              path:   { type: "string", description: "Relative API path, e.g., '/rest/api/content'. Ignored if 'url' is absolute." },
              url:    { type: "string", description: "Absolute URL (optional). If provided, overrides 'path'." },
              query:  { type: "object", description: "Query parameters as object." },
              headers:{ type: "object", description: "Extra headers (Authorization will be overwritten with Basic Auth)." },
              body:   { description: "JSON body object OR raw string (for POST/PUT/PATCH)." },
              responseType: { type: "string", enum: ["json", "arraybuffer"], description: "Default 'json'." },
              timeoutMs: { type: "number", description: "Request timeout in ms (default 60000)." },
              multipart: { type: "boolean", description: "If true: multipart/form-data. Use 'form' and 'files'." },
              form: { type: "object", description: "Key/Value for multipart (non-strings will be stringified)." },
              files: {
                type: "array",
                description: "Attachments when multipart=true. Item: { name:'file', url:'https://..', filename:'my.png' }",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    url: { type: "string" },
                    filename: { type: "string" }
                  },
                  required: ["url"]
                }
              },
              meta: {
                type: "object",
                description: "Optional helper flags (Create/Space-Restriction/Version/Append).",
                properties: {
                  injectDefaultSpace: { type: "boolean", description: "Default true. Uses blocks[].confluence.defaultSpace when creating." },
                  injectDefaultParent: { type: "boolean", description: "Default true. Uses blocks[].confluence.defaultParentId when creating." },
                  allowCrossSpace: { type: "boolean", description: "Default false. If true, disable space restriction for this request." },
                  autoBumpVersion: { type: "boolean", description: "If true and PUT on a page: fetch current version and set version.number = current+1 if not provided." },
                  appendStorageHtml: { type: "string", description: "If set and PUT on a page: fetch current body.storage.value, append this HTML string, and write back." }
                }
              }
            }
          }
        },
        required: ["json"]
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
  getInformation, // ← replaces findTimeframes
  getHistory,
  confluencePage // ← JSON Proxy
};

/** Normalize tool names (aliases + case-insensitive) to the canonical registry key. */
function normalizeToolName(name) {
  if (!name) return "";
  const raw = String(name).trim();
  if (!raw) return "";

  // Legacy alias mapping
  if (raw.toLowerCase() === "findtimeframes") return "getInformation";
  if (raw.toLowerCase() === "getinformation") return "getInformation";
  if (raw.toLowerCase() === "gethistory") return "getHistory";

  // Case-insensitive match against registry
  const keys = Object.keys(fullToolRegistry);
  const hit = keys.find((k) => k.toLowerCase() === raw.toLowerCase());
  return hit || raw;
}

/** Robust: accepts strings or objects (name / function.name / id) and extracts the desired name. */
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

    // 5) OpenAI tool specs filtered by name (order-preserving)
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

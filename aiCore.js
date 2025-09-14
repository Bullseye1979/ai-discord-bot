// aiCore.js — refactored v2.22
// - pseudoPolicy: "auto" | "force" | "off"  (default: "auto")
//   * auto: Pseudo-Schema & Korrekturen nur, wenn der User-Text klar einen Pseudo-Toolcall andeutet
//   * force: Immer Pseudo-Mode (wie v2.19/v2.21)
//   * off:  Pseudo-Mode aus, normaler Chat
// - Tool-Ausgabe-Renderer (TOOL_OUTPUT_HANDLERS): z. B. getImage* => nur URL, getGoogle => Liste
// - Beibehaltung: kein Fabricate, kein Auto-Prompt-Fill, robuster Parser

require("dotenv").config();
const axios = require("axios");
const http = require("http");
const https = require("https");
const { OPENAI_API_URL } = require("./config.js");
const Context = require("./context.js");
const { reportError } = require("./error.js");
const { setBotPresence } = require("./discord-helper.js");

/* -------------------- Debug helper -------------------- */
const DEBUG_PSEUDO = String(process.env.PSEUDO_TOOLS_DEBUG || "1") === "1";
function dbg(...args) {
  if (!DEBUG_PSEUDO) return;
  try { console.log("[PSEUDO]", ...args); } catch {}
}

/** Sanitize 'name' per OpenAI schema; omit for system/tool roles */
function cleanOpenAIName(role, name) {
  if (!name) return undefined;
  if (role === "system" || role === "tool") return undefined;

  let s = String(name)
    .trim()
    .replace(/[\s<|\\/>\u0000-\u001F]/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  s = s.slice(0, 64);
  if (!s) return undefined;

  const reserved = new Set(["assistant", "user", "system", "tool"]);
  if (reserved.has(s.toLowerCase())) return undefined;
  return s;
}

/* -------------------- Transport hardening (keep-alive + retry) -------------------- */

const keepAliveHttpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 16,
  maxFreeSockets: 16,
  timeout: 30_000,
});
const keepAliveHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 16,
  maxFreeSockets: 16,
  timeout: 30_000,
});

const axiosAI = axios.create({
  httpAgent: keepAliveHttpAgent,
  httpsAgent: keepAliveHttpsAgent,
  timeout: 180_000,
  maxRedirects: 0,
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
  validateStatus: (s) => s >= 200 && s < 300,
});

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function deepClone(obj) {
  try { return JSON.parse(JSON.stringify(obj)); } catch { return obj; }
}

/**
 * POST with retry. We deep-clone the payload to keep it 100% stable across retries.
 */
async function postWithRetry(url, payload, headers, tries = 3) {
  let lastErr;
  const stablePayload = deepClone(payload);
  for (let i = 0; i < tries; i++) {
    try {
      const res = await axiosAI.post(url, stablePayload, {
        headers,
        validateStatus: () => true, // log even on 4xx/5xx
      });

      if (res.status >= 200 && res.status < 300) return res;

      console.error("[AI POST][NON-2XX]", {
        try: i + 1,
        status: res.status,
        statusText: res.statusText,
        dataPreview:
          typeof res.data === "string" ? res.data.slice(0, 2000) : res.data,
      });

      if (res.status >= 400 && res.status < 500) {
        const e = new Error(`AI_HTTP_${res.status}`);
        e.response = res;
        throw e;
      }

      lastErr = new Error(`AI_HTTP_${res.status}`);
      await sleep(300 * Math.pow(2, i));
      continue;
    } catch (err) {
      lastErr = err;
      const code = err?.code;
      const msg = String(err?.message || "");
      const transient =
        code === "ECONNRESET" ||
        code === "EPIPE" ||
        code === "ETIMEDOUT" ||
        msg.includes("socket hang up") ||
        msg.includes("ERR_STREAM_PREMATURE_CLOSE");

      console.error("[AI POST][ERROR]", {
        try: i + 1,
        code,
        message: msg,
        status: err?.response?.status || null,
        dataPreview:
          typeof err?.response?.data === "string"
            ? err.response.data.slice(0, 2000)
            : err?.response?.data || null,
      });

      if (!transient || i === tries - 1) throw err;
      await sleep(300 * Math.pow(2, i));
    }
  }
  throw lastErr;
}

/* ---------------------------------------------------------------------------------- */

function normalizeEndpoint(raw) {
  const fallback = "https://api.openai.com/v1/chat/completions";
  let url = (raw || "").trim();
  if (!url) return fallback;

  if (/\/v1\/chat\/completions\/?$/.test(url)) return url.replace(/\/+$/, "");
  if (/\/v1\/?$/.test(url)) return url.replace(/\/v1\/?$/, "/v1/chat/completions");
  if (/\/v1\/responses\/?$/.test(url)) return url.replace(/\/v1\/responses\/?$/, "/v1/chat/completions");
  return url.replace(/\/+$/, "");
}

/**
 * Strictly pair assistant.tool_calls with *all* of their immediate tool replies.
 */
function buildStrictToolPairedMessages(msgs) {
  const out = [];
  let lastToolIds = null;

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];

    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const asst = { role: "assistant", tool_calls: m.tool_calls };
      if (typeof m.content === "string" && m.content.trim()) asst.content = m.content.trim();
      out.push(asst);

      lastToolIds = new Set(m.tool_calls.map(tc => tc && tc.id).filter(Boolean));
      continue;
    }

    if (m.role === "tool") {
      if (m.tool_call_id && lastToolIds && lastToolIds.has(m.tool_call_id)) {
        out.push({ role: "tool", tool_call_id: m.tool_call_id, content: m.content ?? "" });
      }
      continue;
    }

    lastToolIds = null;

    const keep = { role: m.role, content: m.content };
    if (m.name) keep.name = m.name;
    out.push(keep);
  }
  return out;
}

/* -------------------- Tool result persistence as assistant/system -------------------- */

const TOOL_PERSIST_ROLE =
  (process.env.TOOL_PERSIST_ROLE || "assistant").toLowerCase() === "system" ? "system" : "assistant";

const MAX_TOOL_PERSIST_CHARS = Math.max(
  500,
  Math.min(10000, Number(process.env.TOOL_PERSIST_MAX || 8000))
);

function formatToolResultForPersistence(toolName, content) {
  const header = `[TOOL_RESULT:${(toolName || "unknown").trim()}]`;
  let payloadStr;
  if (typeof content === "string") {
    payloadStr = content;
  } else {
    try {
      payloadStr = JSON.stringify(content);
    } catch {
      payloadStr = String(content);
    }
  }

  const looksJSON = /^\s*[\[{]/.test((payloadStr || "").trim());
  let body = looksJSON ? `${header}\n${payloadStr}` : `${header}\n\`\`\`\n${payloadStr}\n\`\`\``;

  if (body.length > MAX_TOOL_PERSIST_CHARS) {
    const tail = "\n…[truncated]";
    body = body.slice(0, MAX_TOOL_PERSIST_CHARS - tail.length) + tail;
  }
  return body;
}

/* -------------------- Simple global priming from ENV -------------------- */

function loadEnvPriming() {
  return (process.env.STANDARDPRIMING || "").trim();
}

/* -------------------- Pseudo tool-calls helpers -------------------- */

/** neutraler Schema-Text aus realen tools.js-Definitionen */
function buildPseudoToolsInstruction(tools, opts = {}) {
  if (!Array.isArray(tools) || tools.length === 0) return "";

  const MAX_TOTAL_CHARS = Math.max(2000, Number(process.env.PSEUDO_SCHEMA_MAX || 6000));
  const MAX_TOOLS = Math.max(1, Number(process.env.PSEUDO_SCHEMA_MAX_TOOLS || 16));
  const MAX_KEYS_PER_TOOL = Math.max(1, Number(process.env.PSEUDO_SCHEMA_MAX_KEYS || 14));
  const DESC_LIMIT = Math.max(80, Number(process.env.PSEUDO_SCHEMA_DESC_LIMIT || 200));

  const pick = (arr, n) => Array.isArray(arr) ? arr.slice(0, n) : [];
  const clampStr = (s, n) => (String(s || "").length > n ? (String(s).slice(0, n - 1) + "…") : String(s || ""));
  const typeOfProp = (prop) => {
    if (!prop) return "any";
    if (Array.isArray(prop.type)) return prop.type.join("|");
    if (prop.type) return String(prop.type);
    if (prop.enum) return `enum(${prop.enum.length})`;
    if (prop.anyOf) return "anyOf";
    if (prop.oneOf) return "oneOf";
    if (prop.allOf) return "allOf";
    return "any";
  };

  const entries = [];
  for (const t of tools) {
    const f = t && (t.function || t.fn || t);
    const name = f?.name ? String(f.name) : null;
    if (!name) continue;

    const params = f?.parameters && typeof f.parameters === "object" ? f.parameters : null;
    const props = params?.properties && typeof params.properties === "object" ? params.properties : {};
    const required = Array.isArray(params?.required) ? params.required : [];

    const keys = Object.keys(props);
    const shownKeys = pick(keys, MAX_KEYS_PER_TOOL).map(k => {
      const typ = typeOfProp(props[k]);
      return `- ${k} (${typ})`;
    });
    if (keys.length > shownKeys.length) {
      shownKeys.push(`- …(+${keys.length - shownKeys.length} weitere)`);
    }

    const sampleArgs = {};
    for (const rk of required) {
      const p = props[rk] || {};
      const typ = typeOfProp(p);
      if (typ.includes("number") || typ === "integer") sampleArgs[rk] = 0;
      else if (typ.includes("boolean")) sampleArgs[rk] = false;
      else if (p?.enum && Array.isArray(p.enum) && p.enum.length > 0) sampleArgs[rk] = p.enum[0];
      else sampleArgs[rk] = "";
    }

    const desc = f?.description ? clampStr(f.description, DESC_LIMIT) : "";
    entries.push({ name, required, shownKeys, sampleArgs, desc });
    if (entries.length >= MAX_TOOLS) break;
  }

  if (entries.length === 0) return "";

  let out = [
    "You MUST use tools via *pseudo tool-calls* when needed.",
    "Output **ONLY** one block, no other text.",
    "",
    "FORMAT (choose exactly one):",
    "1) XML:",
    "<tool_call>",
    '{ "name": "<tool_name>", "arguments": { /* valid JSON args */ } }',
    "</tool_call>",
    "",
    "2) Fenced code:",
    "```tool_call",
    '{ "name": "<tool_name>", "arguments": { /* valid JSON args */ } }',
    "```",
    "",
    "RULES:",
    "- The block must be the ONLY content in your message (no prose before/after).",
    "- Use exactly ONE tool per message.",
    "- JSON must be valid."
  ];

  out.push(`- Available tools: ${entries.map(e => e.name).join(", ")}`, "", "TOOLS:");
  for (const e of entries) {
    out.push(`- ${e.name}${e.desc ? ` — ${e.desc}` : ""}`);
    if (e.required.length > 0) out.push(`  required: ${e.required.join(", ")}`);
    else out.push(`  required: (none)`);
    out.push("  keys:");
    for (const line of e.shownKeys) out.push(`  ${line}`);
    const sample = JSON.stringify({ name: e.name, arguments: e.sampleArgs }, null, 2);
    out.push("  example:\n  ```tool_call");
    out.push(sample.split("\n").map(l => "  " + l).join("\n"));
    out.push("  ```");
  }

  let text = out.join("\n");
  if (text.length > MAX_TOTAL_CHARS) {
    text = text.slice(0, MAX_TOTAL_CHARS - 20) + "\n…";
  }
  return text;
}

/** toleranter pseudo-call extractor */
function extractPseudoToolCalls(text) {
  if (!text || typeof text !== "string") return [];
  const calls = [];

  const pushIfValid = (obj) => {
    try {
      if (!obj || typeof obj !== "object") return;
      const name =
        obj.name ||
        obj?.tool?.name ||
        obj?.function?.name;
      const args =
        obj.arguments ||
        obj?.tool?.arguments ||
        obj?.function?.arguments ||
        {};
      if (!name) return;
      calls.push({ name: String(name), arguments: args || {} });
    } catch {}
  };

  try { pushIfValid(JSON.parse(text)); } catch {}
  (function(){
    const re = /<tool_call>([\s\S]*?)<\/tool_call>/gi; let m;
    while ((m = re.exec(text)) !== null) { const raw = (m[1] || "").trim(); try { pushIfValid(JSON.parse(raw)); } catch {} }
  })();
  (function(){
    const re = /```(?:tool_call|json|javascript|js)\s*([\s\S]*?)```/gi; let m;
    while ((m = re.exec(text)) !== null) { const raw = (m[1] || "").trim(); try { pushIfValid(JSON.parse(raw)); } catch {} }
  })();
  (function(){
    const re = /<toolcall>([\s\S]*?)<\/toolcall>/gi; let m;
    while ((m = re.exec(text)) !== null) { const raw = (m[1] || "").trim(); try { pushIfValid(JSON.parse(raw)); } catch {} }
  })();
  (function(){
    const re = /(^|\n)\s*([A-Za-z0-9_\-\.]+)\s*\n\s*(\{[\s\S]*\})/g; let m;
    while ((m = re.exec(text)) !== null) { const name = (m[2] || "").trim(); const json = (m[3] || "").trim(); try { pushIfValid({ name, arguments: JSON.parse(json) || {} }); } catch {} }
  })();

  return calls;
}

function lastConcreteUserPrompt(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const c = (m.content || "").trim();
    if (!c) continue;
    if (c.toLowerCase() === "continue") continue;
    if (c.startsWith("FEHLER:")) continue;
    return c;
  }
  return "";
}

/** erkennt, ob der User-Text *klar* Pseudo-Toolcalls will */
function userTriggersPseudoTools(userText, tools) {
  if (!userText || typeof userText !== "string") return false;
  const s = userText;
  if (s.includes("<tool_call>") || s.includes("</tool_call>")) return true;
  if (/```tool_call/.test(s)) return true;
  try {
    const j = JSON.parse(s);
    if (j && (j.name || j?.tool?.name || j?.function?.name)) return true;
  } catch {}
  // Muster: TOOLNAME + JSON
  const toolNames = (tools || [])
    .map(t => t?.function?.name || t?.name)
    .filter(Boolean);
  for (const nm of toolNames) {
    const re = new RegExp(`(^|\\n)\\s*${nm}\\s*\\n\\s*\\{`);
    if (re.test(s)) return true;
  }
  return false;
}

/** sanitize/complete args for image-like tools (ohne Auto-Prompt-Fill) */
function sanitizeArgsForImageTool(args, options = {}) {
  const out = Object.assign({}, args || {});
  const defSize = options.defaultImageSize || "1024x1024";
  const must = (v) => v != null && String(v).trim().length > 0;

  if (!must(out.prompt) && must(out.text)) { out.prompt = String(out.text).trim(); delete out.text; }
  if (!must(out.prompt) && must(out.query)) { out.prompt = String(out.query).trim(); delete out.query; }
  if (!must(out.prompt) && must(out.description)) { out.prompt = String(out.description).trim(); delete out.description; }

  if (!must(out.size)) out.size = defSize;
  if (typeof out.size === "string") {
    const s = out.size.toLowerCase().trim();
    if (s === "square") out.size = "1024x1024";
    if (/^\d{3,4}x\d{3,4}$/.test(s) === false) out.size = defSize;
  } else {
    out.size = defSize;
  }
  return out;
}

/* -------------------- Tool Output Rendering -------------------- */

// Per-Tool Ausgabeverhalten: Liefert finalen Antwort-String.
const TOOL_OUTPUT_HANDLERS = {
  // Image-Tools → nur URL (Plaintext)
  getImageSD: (obj, { urlList }) => {
    if (obj && obj.url) return obj.url;
    return ""; // kein URL -> leer (Assembler hat Fallbacks)
  },
  getImage: (obj, ctx) => TOOL_OUTPUT_HANDLERS.getImageSD(obj, ctx),

  // Google-Tool → kompakte Liste: "Titel — URL"
  getGoogle: (obj /*, ctx*/) => {
    try {
      const res = [];
      if (Array.isArray(obj?.results)) {
        for (const it of obj.results) {
          const title = (it.title || it.name || "").toString().trim();
          const link  = (it.url || it.link || it.href || "").toString().trim();
          if (title && link) res.push(`${title} — ${link}`);
          else if (link) res.push(link);
          if (res.length >= 5) break;
        }
      }
      if (res.length > 0) return res.join("\n");
      // andere Formate:
      if (typeof obj?.url === "string") return obj.url;
      if (Array.isArray(obj) && obj.length > 0) {
        const out = [];
        for (const it of obj) {
          const title = (it?.title || it?.name || "").toString().trim();
          const link  = (it?.url || it?.link || it?.href || "").toString().trim();
          if (title && link) out.push(`${title} — ${link}`);
          else if (link) out.push(link);
          if (out.length >= 5) break;
        }
        if (out.length > 0) return out.join("\n");
      }
    } catch {}
    return ""; // Assembler fallback greift
  },
};

// Fallback: Kürze JSON hübsch
function prettyClipJSON(any, max = 2000) {
  let s;
  try { s = typeof any === "string" ? any : JSON.stringify(any, null, 2); }
  catch { s = String(any); }
  if (s.length > max) s = s.slice(0, max - 1) + "…";
  return s;
}

/**
 * Run a chat loop with tool-calls and bounded auto-continue.
 */
async function getAIResponse(
  context_orig,
  tokenlimit = 4096,
  sequenceLimit = 1000,
  model = "gpt-4o",
  apiKey = null,
  options = {},
  client = null
) {
  let responseMessage = "";
  const pendingUser = options?.pendingUser || null;
  const noPendingInject = options?.noPendingUserInjection === true;

  // NEW: pseudoPolicy
  const pseudoPolicy = options?.pseudoPolicy || "auto"; // "auto" | "force" | "off"

  const noToolcallPolicy = options?.noToolcallPolicy || "silent"; // "silent" | "error" | "echo"

  let context = null;
  let handoverContext = null;

  try {
    if (tokenlimit == null) tokenlimit = 4096;

    // Activate pseudo only per policy
    const wantPseudo = (pseudoPolicy === "force")
      || (pseudoPolicy === "auto" && userTriggersPseudoTools(pendingUser?.content || "", (context_orig.tools || [])));
    const pseudoFlag = wantPseudo; // ersetzt früheres globales Flag

    // Working copies
    context = new Context(
      "",
      "",
      context_orig.tools,
      context_orig.toolRegistry,
      context_orig.channelId || null,
      { skipInitialSummaries: true, persistToDB: false, pseudoToolcalls: !!pseudoFlag }
    );
    context.messages = [...context_orig.messages];

    handoverContext = new Context(
      "",
      "",
      context_orig.tools,
      context_orig.toolRegistry,
      context_orig.channelId || null,
      { skipInitialSummaries: true, persistToDB: false, pseudoToolcalls: !!pseudoFlag }
    );
    handoverContext.messages = [...context_orig.messages];

    // Compose system
    try {
      const sysParts = [];
      const priming = loadEnvPriming();
      if (priming) sysParts.push(`General rules:\n${priming}`);
      if ((context_orig.persona || "").trim()) sysParts.push(String(context_orig.persona).trim());
      if ((context_orig.instructions || "").trim()) sysParts.push(String(context_orig.instructions).trim());

      if (pseudoFlag === true) {
        const schema = buildPseudoToolsInstruction(context.tools || []);
        if (schema) {
          sysParts.push(schema);
          const toolNames = (context.tools || []).map(t => t?.function?.name || t?.name).filter(Boolean);
          dbg("Injected pseudo-tools schema. Tools:", toolNames);
          dbg("Schema:\n" + schema);
        }
      }

      const sysCombined = sysParts.join("\n\n").trim();
      if (sysCombined) {
        context.messages.unshift({ role: "system", content: sysCombined });
      }
    } catch {}

    // Time hint
    const nowUtc = new Date().toISOString();
    context.messages.unshift({
      role: "system",
      content: `Current UTC time: ${nowUtc} <- Use this time whenever asked. Translate to the requested location; if none, use your current location.`,
    });

    // Pending user ONLY to working copy if requested
    if (pendingUser && pendingUser.content && !noPendingInject) {
      const safeName = cleanOpenAIName("user", pendingUser.name || "user");
      const msg = { role: "user", content: pendingUser.content };
      if (safeName) msg.name = safeName;
      context.messages.push(msg);
      handoverContext.messages.push({ ...msg });
    }

    const toolCommits = [];
    let continueResponse = false;
    let sequenceCounter = 0;

    const authKey = apiKey || process.env.OPENAI_API_KEY;

    // Pseudo correction limit
    let pseudoRetryCount = 0;
    const pseudoRetryMax = 2;

    let hadToolCallsThisTurn = false;
    let lastToolResults = []; // Array<{ name, raw }>
    let lastRawAssistant = ""; // für noToolcallPolicy="echo"

    do {
      hadToolCallsThisTurn = false;

      const safeMsgs = buildStrictToolPairedMessages(context.messages);

      const messagesToSend = safeMsgs.map((m) => {
        const out = { role: m.role, content: m.content };
        const safeName = cleanOpenAIName(m.role, m.name);
        if (safeName) out.name = safeName;
        if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
          out.tool_calls = m.tool_calls;
        }
        if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
        return out;
      });

      const payload = {
        model,
        messages: messagesToSend,
        max_tokens: tokenlimit
      };
      // In pseudoMode benutzen wir KEIN native tools/tool_choice
      if (!pseudoFlag && Array.isArray(context.tools) && context.tools.length > 0) {
        payload.tools = context.tools;
        payload.tool_choice = "auto";
      }

      const configuredRaw =
        (options?.endpoint || "").trim() ||
        (process.env.OPENAI_API_URL || "").trim() ||
        (OPENAI_API_URL || "").trim();

      const endpoint =
        normalizeEndpoint(configuredRaw) || "https://api.openai.com/v1/chat/completions";

      dbg("Request →", {
        endpoint,
        model,
        tokenlimit,
        sequenceCounter,
        pseudoFlag,
        tools: (!pseudoFlag && Array.isArray(context.tools))
          ? context.tools.map(t => t?.function?.name || t?.name || "unknown")
          : []
      });

      // Headers
      const headers = {
        "Content-Type": "application/json",
        "Connection": "keep-alive",
      };
      if (authKey) headers.Authorization = `Bearer ${authKey}`;

      // Call with stable payload
      let aiResponse;
      try {
        aiResponse = await postWithRetry(endpoint, payload, headers);
      } catch (err) {
        const details = { endpoint, status: err?.response?.status, data: err?.response?.data };
        await reportError(err, null, "OPENAI_CHAT", { details });
        try { console.error("[OPENAI_CHAT][REQUEST_DEBUG]", JSON.stringify({
          endpoint,
          model,
          payloadPreview: {
            messages: messagesToSend.slice(-6),
            tools: (!pseudoFlag && Array.isArray(context.tools))
              ? context.tools.map(t => t?.function?.name || t?.name)
              : [],
          }
        }, null, 2)); } catch {}
        console.log("\n\n=== CONTEXT RAW DUMP ===\n", context?.messages || [], "\n=== /CONTEXT RAW DUMP ===\n");
        throw err;
      }

      const choice = aiResponse?.data?.choices?.[0] || {};
      const aiMessage = choice.message || {};
      const finishReason = choice.finish_reason;

      const toolCallsFromModel = Array.isArray(aiMessage.tool_calls) ? aiMessage.tool_calls : [];
      let hasToolCalls = toolCallsFromModel.length > 0;

      // Assistant content
      const rawFromModel = (aiMessage.content || "").trim();
      if (rawFromModel) dbg("Assistant text (raw):", rawFromModel);
      lastRawAssistant = rawFromModel;
      let assistantText = pseudoFlag ? "" : rawFromModel; // Pseudo: nie Prosa akkumulieren

      // Pseudo detection (from raw text)
      let pseudoCalls = [];
      if (pseudoFlag && rawFromModel) {
        pseudoCalls = extractPseudoToolCalls(rawFromModel);
        if (pseudoCalls.length > 0) dbg("Detected pseudo tool-calls:", pseudoCalls);
      }

      // In pseudo-mode: nur bei echtem pseudoCall korrigieren; keine Auto-Fabrication
      if (pseudoFlag === true && !hasToolCalls && pseudoCalls.length === 0) {
        if (pseudoRetryCount < pseudoRetryMax) {
          pseudoRetryCount++;
          const originalUser = lastConcreteUserPrompt(messagesToSend);
          const pin = originalUser ? `\nAUFTRAG (wiederholt): ${originalUser}` : "";
          dbg("Prose without tool_call detected. Sending strict correction (retry", pseudoRetryCount, ")", pin ? "(with pinned user request)" : "");
          context.messages.push({
            role: "user",
            content:
              "FEHLER: Du hast Prosa gesendet. Sende JETZT ausschließlich einen einzigen <tool_call>…</tool_call>-Block ODER einen ```tool_call```-Block mit gültigem JSON {name, arguments}. KEINE ERKLÄRUNGEN." + pin
          });
          continueResponse = true;
          sequenceCounter++;
          continue;
        } else {
          dbg("Max pseudo retries reached — no toolcall fabricated (per policy).");
          break; // keine weitere Erzwingung
        }
      }

      if (!pseudoFlag && assistantText) {
        responseMessage += assistantText;
      }

      // Native tool_calls passthrough (non-pseudo)
      if (hasToolCalls && !pseudoFlag) {
        dbg("Native tool_calls:", toolCallsFromModel.map(tc => tc?.function?.name));
        context.messages.push({ role: "assistant", tool_calls: toolCallsFromModel });
      }

      // Pseudo → genau EIN bester Toolcall aus Parsed Calls
      if (pseudoCalls.length > 0 && pseudoFlag) {
        const best = (function pickBest(pseudoCalls) {
          if (!Array.isArray(pseudoCalls) || pseudoCalls.length === 0) return null;
          const hasValue = (v) => v != null && String(v).trim().length > 0;
          const score = (pc) => {
            try {
              const args = pc?.arguments || {};
              const vals = Object.values(args);
              if (vals.length === 0) return 0;
              return vals.reduce((acc, v) => acc + (hasValue(v) ? 1 : 0), 0);
            } catch { return 0; }
          };
          let best = pseudoCalls[0];
          let bestScore = score(best);
          for (let i = 1; i < pseudoCalls.length; i++) {
            const sc = score(pseudoCalls[i]);
            if (sc > bestScore) { best = pseudoCalls[i]; bestScore = sc; }
          }
          return best;
        })(pseudoCalls);

        if (best) {
          if (/image|getimage|sd|stable/i.test(best.name)) {
            best.arguments = sanitizeArgsForImageTool(best.arguments, {
              defaultImageSize: options.defaultImageSize || "1024x1024",
            });
          }
          const fabricated = [{
            id: `call_${Date.now()}_0`,
            type: "function",
            function: { name: best.name, arguments: JSON.stringify(best.arguments || {}) }
          }];
          context.messages.push({ role: "assistant", tool_calls: fabricated });
          hasToolCalls = true;
        } else {
          hasToolCalls = false;
        }
      }

      if (hasToolCalls) {
        hadToolCallsThisTurn = true;

        const callsToHandle = context.messages[context.messages.length - 1]?.tool_calls || [];
        const loopCalls = pseudoFlag ? callsToHandle.slice(0, 1) : callsToHandle;

        for (const toolCall of loopCalls) {
          const fnName = toolCall?.function?.name;
          if (client != null && fnName) {
            setBotPresence(client, "⌛ " + fnName, "online");
          }
          const toolFunction = context.toolRegistry ? context.toolRegistry[fnName] : undefined;

          const replyTool = (content) => {
            const out =
              typeof content === "string" || content == null
                ? content || ""
                : (() => { try { return JSON.stringify(content); } catch { return String(content); } })();

            context.messages.push({ role: "tool", tool_call_id: toolCall.id, content: out });
            toolCommits.push({ name: fnName || "tool", content: out });
            lastToolResults.push({ name: fnName || "tool", raw: out });
          };

          if (!toolFunction || !toolCall?.function) {
            replyTool(`[ERROR]: Tool '${fnName || "unknown"}' not available or arguments invalid.`);
            dbg("Tool missing or invalid:", fnName);
            continue;
          }

          // Args
          let parsedArgs = {};
          try {
            const raw = toolCall?.function?.arguments || "{}";
            parsedArgs = typeof raw === "string" ? JSON.parse(raw) : (raw || {});
          } catch { parsedArgs = {}; }

          if (/image|getimage|sd|stable/i.test(fnName)) {
            parsedArgs = sanitizeArgsForImageTool(parsedArgs, {
              defaultImageSize: options.defaultImageSize || "1024x1024",
            });
          }

          dbg("Execute tool:", fnName, "args:", parsedArgs);

          try {
            const runtime = { channel_id: context_orig.channelId || handoverContext.channelId || null };
            const toolResult = await toolFunction({ name: fnName, arguments: parsedArgs }, handoverContext, getAIResponse, runtime);

            const preview =
              typeof toolResult === "string" ? toolResult.slice(0, 300) :
              (() => { try { return JSON.stringify(toolResult).slice(0, 300); } catch { return String(toolResult).slice(0, 300); } })();
            dbg("Tool result preview:", preview);

            replyTool(toolResult || "");
          } catch (toolError) {
            const emsg = toolError?.message || String(toolError);
            await reportError(toolError, null, `TOOL_${(fnName || "unknown").toUpperCase()}`);
            dbg("Tool error:", fnName, emsg);
            replyTool(JSON.stringify({ error: emsg, tool: fnName || "unknown" }));
          }
        }

        if (pseudoFlag) {
          continueResponse = false;
          break;
        }
      }

      sequenceCounter++;

      const dueToLength = !hasToolCalls && finishReason === "length";
      if (sequenceLimit <= 1) {
        continueResponse = false;
      } else if (hasToolCalls) {
        if (!pseudoFlag) {
          if (sequenceCounter < sequenceLimit) {
            context.messages.push({ role: "user", content: "continue" });
            continueResponse = true;
          } else {
            continueResponse = false;
          }
        } else {
          continueResponse = false;
        }
      } else if (dueToLength) {
        if (sequenceCounter < sequenceLimit) {
          if (assistantText) {
            context.messages.push({ role: "assistant", content: assistantText });
          }
          context.messages.push({ role: "user", content: "continue" });
          continueResponse = true;
        } else {
          continueResponse = false;
        }
      } else {
        continueResponse = false;
      }
    } while (hadToolCallsThisTurn || continueResponse);

    // ----- Assemble final output from tool results or assistant text -----

    if (lastToolResults.length > 0) {
      // Versuche pro Tool einen passenden Renderer
      const rendered = [];
      for (const item of lastToolResults) {
        const { name, raw } = item;
        let obj = null;
        try { obj = JSON.parse(raw); } catch {}
        const handler = TOOL_OUTPUT_HANDLERS[name];
        if (handler) {
          const s = handler(obj || {}, { urlList: options.urlList === true });
          if (s && s.trim()) rendered.push(s.trim());
        } else if (obj && obj.url) {
          // generische URL-Erkennung
          rendered.push(String(obj.url));
        } else if (obj) {
          rendered.push(prettyClipJSON(obj, 1800));
        } else if (raw && raw.trim()) {
          rendered.push(prettyClipJSON(raw, 1800));
        }
      }

      if (rendered.length > 0) {
        // Pseudo-Mode: KEIN Markdown, Plaintext
        responseMessage = (pseudoPolicy !== "off") ? rendered.join("\n\n") : rendered.join("\n\n");
      } else {
        // Fallback je Policy
        if (noToolcallPolicy === "error") {
          responseMessage = "TOOLCALL_MISSING";
        } else if (noToolcallPolicy === "echo") {
          responseMessage = String(lastRawAssistant || "");
        } else {
          responseMessage = "";
        }
      }
    } else if (responseMessage.trim().length === 0) {
      if (noToolcallPolicy === "error") {
        responseMessage = "TOOLCALL_MISSING";
      } else if (noToolcallPolicy === "echo") {
        responseMessage = String(lastRawAssistant || "");
      } else {
        responseMessage = "";
      }
    }

    // Persist tool outputs
    if (toolCommits.length > 0) {
      let t0 = (pendingUser && pendingUser.timestamp) ? pendingUser.timestamp : Date.now();
      for (let i = 0; i < toolCommits.length; i++) {
        const tmsg = toolCommits[i];
        const wrapped = formatToolResultForPersistence(tmsg.name, tmsg.content);
        const persistName = TOOL_PERSIST_ROLE === "assistant" ? "ai" : undefined;
        try { await context_orig.add(TOOL_PERSIST_ROLE, persistName, wrapped, t0 + i + 1); } catch {}
      }
    }

    return responseMessage;
  } catch (err) {
    const details = { status: err?.response?.status, data: err?.response?.data };
    await reportError(err, null, "GET_AI_RESPONSE", { details });

    try {
      console.error(
        "[GET_AI_RESPONSE][CONTEXT_DEBUG]",
        JSON.stringify(
          {
            contextMessages: Array.isArray(context?.messages) ? context.messages : [],
            handoverMessages: Array.isArray(handoverContext?.messages) ? handoverContext.messages : [],
          },
          null,
          2
        )
      );
    } catch {}
    console.log("\n\n=== CONTEXT OBJ RAW ===\n", context || {}, "\n=== /CONTEXT OBJ RAW ===\n");
    throw err;
  }
}

module.exports = { getAIResponse };

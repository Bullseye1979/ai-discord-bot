// aiCore.js — refactored v2.17 (endpoint override + conditional auth + pseudo-toolcalls + debug logs)
// Chat loop with tool-calls, safe logging, strict auto-continue guard.
// v2.0 … v2.16 (siehe Historie)
// v2.17: Link-Normalisierung (Angle-Brackets, Quotes, trailing Punct), Absolut-Pfad-Bau via PUBLIC_BASE_URL,
//        robuste URL-Ernte aus Tool-Resulten, reine-URL-Ausgabe im Pseudo-Mode, Antwortsäuberung.

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

/* -------------------- URL normalization helpers -------------------- */

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");

function normalizeUrl(u) {
  if (!u || typeof u !== "string") return null;
  let s = u.trim();

  // strip angle brackets and quotes
  s = s.replace(/^<+/, "").replace(/>+$/, "");
  s = s.replace(/^['"]+/, "").replace(/['"]+$/, "");

  // remove trailing punctuations common in inline text
  s = s.replace(/[),.;:!?]+$/g, "");

  // collapse spaces
  s = s.replace(/\s+/g, "");

  if (!s) return null;

  // simple sanity check
  if (!/^https?:\/\//i.test(s) && !s.startsWith("/")) return null;
  return s;
}

function coerceAbsoluteUrl(u) {
  const n = normalizeUrl(u);
  if (!n) return null;
  if (/^https?:\/\//i.test(n)) return n;
  if (n.startsWith("/") && PUBLIC_BASE_URL) {
    return `${PUBLIC_BASE_URL}${n}`;
  }
  return null;
}

function collectUrlsFromToolResult(raw) {
  const urls = new Set();

  const pushMaybe = (val) => {
    if (!val) return;
    const abs = coerceAbsoluteUrl(val) || normalizeUrl(val);
    if (abs && /^https?:\/\//i.test(abs)) urls.add(abs);
  };

  const scanObj = (obj) => {
    if (!obj || typeof obj !== "object") return;

    // canonical fields
    pushMaybe(obj.url);
    pushMaybe(obj.link);
    pushMaybe(obj.href);
    pushMaybe(obj.image);
    pushMaybe(obj.file); // may be http or /documents/...
    // arrays
    for (const key of ["urls", "links", "images"]) {
      const arr = obj[key];
      if (Array.isArray(arr)) arr.forEach(pushMaybe);
    }
  };

  // raw can be stringified JSON or plain string URL
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === "object") {
      scanObj(parsed);
    }
  } catch {
    // try to pick single URL from plain string
    pushMaybe(String(raw || ""));
  }

  return [...urls];
}

function stripAngleBracketsInText(text) {
  if (!text) return text;
  // turn <http://...> into http://...
  return text.replace(/<\s*(https?:\/\/[^>\s]+)\s*>/gi, "$1");
}

/* -------------------- Pseudo tool-calls helpers -------------------- */

function buildPseudoToolsInstruction(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "";
  const names = tools
    .map(t => t?.function?.name || t?.name)
    .filter(Boolean);

  if (names.length === 0) return "";

  const exampleTool = names[0];

  return [
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
    "- JSON must be valid.",
    `- Available tools: ${names.join(", ")}`,
    "",
    "EXAMPLE:",
    "<tool_call>",
    `{ "name": "${exampleTool}", "arguments": { "prompt": "a cute robot, cinematic light, 4k", "size": "1024x1024" } }`,
    "</tool_call>",
  ].join("\n");
}

function extractPseudoToolCalls(text) {
  if (!text || typeof text !== "string") return [];

  const calls = [];

  // 1) XML-like tag <tool_call> ... </tool_call>
  const reTag = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let m;
  while ((m = reTag.exec(text)) !== null) {
    const raw = (m[1] || "").trim();
    try {
      const json = JSON.parse(raw);
      if (json && typeof json === "object" && json.name) {
        calls.push({ name: String(json.name), arguments: json.arguments || {} });
      }
    } catch {}
  }

  // 2) Code fence ```tool_call { ... } ``` and ```json { ... } ```
  const reFence = /```(?:tool_call|json)\s*([\s\S]*?)```/gi;
  while ((m = reFence.exec(text)) !== null) {
    const raw = (m[1] || "").trim();
    try {
      const json = JSON.parse(raw);
      if (json && typeof json === "object" && json.name) {
        calls.push({ name: String(json.name), arguments: json.arguments || {} });
      }
    } catch {}
  }

  // 3) Variant: <toolcall>{...}</toolcall>
  const reAlt = /<toolcall>([\s\S]*?)<\/toolcall>/gi;
  while ((m = reAlt.exec(text)) !== null) {
    const raw = (m[1] || "").trim();
    try {
      const json = JSON.parse(raw);
      if (json && typeof json === "object" && json.name) {
        calls.push({ name: String(json.name), arguments: json.arguments || {} });
      }
    } catch {}
  }

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

/* -------------------- Main -------------------- */

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

  let context = null;
  let handoverContext = null;

  try {
    if (tokenlimit == null) tokenlimit = 4096;

    const pseudoFlag = options?.pseudotoolcalls === true || context_orig?.pseudoToolcalls === true;

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

    const toolRegistry = context.toolRegistry;

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

    let pseudoRetryCount = 0;
    const pseudoRetryMax = 2;

    let hadToolCallsThisTurn = false;
    let lastToolResults = [];

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
      let assistantText = typeof aiMessage.content === "string" ? aiMessage.content.trim() : "";
      if (assistantText) dbg("Assistant text (raw):", assistantText);

      // Pseudo detection
      let pseudoCalls = [];
      if (pseudoFlag === true && assistantText) {
        pseudoCalls = extractPseudoToolCalls(assistantText);
        if (pseudoCalls.length > 0) dbg("Detected pseudo tool-calls:", pseudoCalls);
      }

      // In pseudo-mode: if no toolcalls were produced, do NOT accumulate prose
      if (pseudoFlag === true && !hasToolCalls && pseudoCalls.length === 0) {
        assistantText = ""; // drop hallucinated prose
      }

      // Hard correction prompt (carry original user request)
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
          dbg("Max pseudo retries reached; giving up without prose.");
        }
      }

      if (assistantText) {
        // cleanup angle-bracketed URLs inside prose
        responseMessage += stripAngleBracketsInText(assistantText);
      }

      if (hasToolCalls) {
        dbg("Native tool_calls:", toolCallsFromModel.map(tc => tc?.function?.name));
        context.messages.push({ role: "assistant", tool_calls: toolCallsFromModel });
      }

      if (pseudoCalls.length > 0) {
        const fabricated = pseudoCalls.map((pc, idx) => ({
          id: `call_${Date.now()}_${idx}`,
          type: "function",
          function: { name: pc.name, arguments: JSON.stringify(pc.arguments || {}) }
        }));
        context.messages.push({ role: "assistant", tool_calls: fabricated });
        hasToolCalls = true;
      }

      if (hasToolCalls) {
        hadToolCallsThisTurn = true;

        const callsToHandle = context.messages[context.messages.length - 1]?.tool_calls || [];

        for (const toolCall of callsToHandle) {
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
            lastToolResults.push(out);
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

        if (pseudoFlag === true) {
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

    // Direct reply from tool results in pseudo-mode: emit clean URLs only
    if (responseMessage.trim().length === 0 && lastToolResults.length > 0) {
      const allUrls = new Set();
      for (const r of lastToolResults) {
        collectUrlsFromToolResult(r).forEach(u => allUrls.add(u));
      }
      if (allUrls.size > 0) {
        // Just plain URLs, each on its own line — Discord will auto-embed
        responseMessage = [...allUrls].join("\n");
      } else {
        const raw = String(lastToolResults[lastToolResults.length - 1] || "").trim();
        responseMessage = raw.length > 1500 ? (raw.slice(0, 1490) + " …") : raw;
      }
    } else if (responseMessage) {
      // final cleanup: strip <url> patterns if any leaked
      responseMessage = stripAngleBracketsInText(responseMessage);
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

// aiCore.js — refactored v2.14 (endpoint override + conditional auth + pseudo-toolcalls + debug logs)
// Chat loop with tool-calls, safe logging, strict auto-continue guard.
// v2.0: pendingUser working-copy + post-commit with original timestamp.
// v2.3: prune orphan historical `tool` msgs when building payload.
// v2.4: PERSIST tool results as `assistant` (or `system`) messages with a clear wrapper.
// v2.5: CAP persisted tool-result wrapper to 3000 chars (config via TOOL_PERSIST_MAX).
// v2.6: Transport hardening (keep-alive + retry) + endpoint normalization.
// v2.7: SIMPLE GLOBAL PRIMING from env -> "General rules:\n{STANDARDPRIMING}" prepended to persona+instructions.
// v2.8: Hardened tool_call flow (no empty tool_calls; strict ordering intent in loop).
// v2.9: Strict payload pairing (buildStrictToolPairedMessages) + request/context debug snapshots.
// v2.10: Endpoint precedence (options.endpoint > ENV > config > default) + conditional Authorization.
// v2.11: ❗No user-message persistence here; bot.js logs user turns pre-call.
//        Added options.noPendingUserInjection to avoid duplicating user content in working copy.
// v2.12: PSEUDO-TOOLCALLS for local models (Qwen/Llama/etc.)
//        - Schema injection into system prompt
//        - Detect <tool_call>{...}</tool_call> & variants in assistant text
//        - Execute via registry and commit as proper GPT tool messages
// v2.13: DEBUG: console dumps for schema/tools, payload preview, assistant text, parsed pseudo-calls, tool exec
// v2.14: ❗When pseudotoolcalls=true → do NOT send tools/tool_choice in payload (fix 500s on local endpoints)

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

/**
 * POST with retry. On non-2xx, we log details explicitly.
 * NOTE: we override validateStatus here to always get a response,
 * then we decide to throw based on status range.
 */
async function postWithRetry(url, payload, headers, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await axiosAI.post(url, payload, {
        headers,
        validateStatus: () => true, // log even on 4xx/5xx
      });

      if (res.status >= 200 && res.status < 300) return res;

      // Non-2xx: log snapshot
      console.error("[AI POST][NON-2XX]", {
        try: i + 1,
        status: res.status,
        statusText: res.statusText,
        dataPreview:
          typeof res.data === "string" ? res.data.slice(0, 2000) : res.data,
      });

      // For 4xx, do not retry (payload issue)
      if (res.status >= 400 && res.status < 500) {
        const e = new Error(`AI_HTTP_${res.status}`);
        e.response = res;
        throw e;
      }

      // For 5xx, retry
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
      await sleep(300 * Math.pow(2, i)); // 300ms, 600ms, 1200ms
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

/**
 * Run a chat loop with tool-calls and bounded auto-continue.
 * @param {Context} context_orig
 * @param {number}  tokenlimit
 * @param {number}  sequenceLimit
 * @param {string}  model
 * @param {string|null} apiKey
 * @param {object}  options               // { pendingUser?: {name, content, timestamp}, endpoint?: string, noPendingUserInjection?: boolean, pseudotoolcalls?: boolean }
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

  try {
    if (tokenlimit == null) tokenlimit = 4096;

    // 🔧 Resolve pseudo-toolcalls flag from options OR original context
    const pseudoFlag = options?.pseudotoolcalls === true || context_orig?.pseudoToolcalls === true;

    // Working copies (reply context + tool-handover)
    const context = new Context(
      "",
      "",
      context_orig.tools,
      context_orig.toolRegistry,
      context_orig.channelId || null,
      { skipInitialSummaries: true, persistToDB: false, pseudoToolcalls: !!pseudoFlag }
    );
    context.messages = [...context_orig.messages];

    const handoverContext = new Context(
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

      // Pseudo-toolcalls schema (only if enabled)
      if (pseudoFlag === true) {
        const schema = buildPseudoToolsInstruction(context.tools || []);
        if (schema) {
          sysParts.push(schema);
          // DEBUG: emit schema + tool list
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

    // Pending user ONLY to working copy if requested (avoid duplicate when bot.js pre-logged)
    if (pendingUser && pendingUser.content && !noPendingInject) {
      const safeName = cleanOpenAIName("user", pendingUser.name || "user");
      const msg = { role: "user", content: pendingUser.content };
      if (safeName) msg.name = safeName;
      context.messages.push(msg);
      handoverContext.messages.push({ ...msg });
    }

    const toolCommits = []; // { name: fnName, content: string }
    let continueResponse = false;
    let sequenceCounter = 0;

    const authKey = apiKey || process.env.OPENAI_API_KEY;

    // ➕ Auto-Korrektur Guard: begrenzte Retries, falls Prosa statt Toolcall
    let pseudoRetryCount = 0;
    const pseudoRetryMax = 2;

    // Loop until tools are resolved and optional continue chain done
    let hadToolCallsThisTurn = false;
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

      // 🔑 Build payload — OMIT tools/tool_choice when pseudotoolcalls is enabled
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

      // DEBUG: request snapshot (compact)
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

      // API Call (with retry)
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

      // Append assistant text (if any) — but guard for pseudo toolcalls
      let assistantText = typeof aiMessage.content === "string" ? aiMessage.content.trim() : "";
      if (assistantText) dbg("Assistant text (raw):", assistantText);

      // PSEUDO-TOOLCALL DETECTION
      let pseudoCalls = [];
      if (pseudoFlag === true && assistantText) {
        pseudoCalls = extractPseudoToolCalls(assistantText);
        if (pseudoCalls.length > 0) dbg("Detected pseudo tool-calls:", pseudoCalls);
      }

      // 🔧 Auto-Korrektur: Prosa ohne Toolcalls → harte Korrektur (max. 2x)
      if (pseudoFlag === true && !hasToolCalls && pseudoCalls.length === 0 && assistantText) {
        if (pseudoRetryCount < pseudoRetryMax) {
          pseudoRetryCount++;
          dbg("Prose without tool_call detected. Sending strict correction (retry", pseudoRetryCount, ")");
          context.messages.push({
            role: "user",
            content:
              "FEHLER: Du hast Prosa gesendet. Sende JETZT ausschließlich einen einzigen <tool_call>…</tool_call>-Block ODER einen ```tool_call```-Block mit gültigem JSON {name, arguments}. KEINE ERKLÄRUNGEN."
          });
          continueResponse = true;
          sequenceCounter++;
          continue; // nächste Schleife
        } else {
          dbg("Max pseudo retries reached; returning prose to caller.");
        }
      }

      if (pseudoCalls.length > 0) {
        // prevent raw tag from leaking into the visible assistant text
        assistantText = "";
      }

      if (assistantText) {
        responseMessage += assistantText;
      }

      // If the model returned native tool_calls (OpenAI style)
      if (hasToolCalls) {
        dbg("Native tool_calls:", toolCallsFromModel.map(tc => tc?.function?.name));
        context.messages.push({ role: "assistant", tool_calls: toolCallsFromModel });
      }

      // If PSEUDO calls were present, convert to native tool_calls and process identically
      if (pseudoCalls.length > 0) {
        const fabricated = pseudoCalls.map((pc, idx) => ({
          id: `call_${Date.now()}_${idx}`,
          type: "function",
          function: { name: pc.name, arguments: JSON.stringify(pc.arguments || {}) }
        }));
        context.messages.push({ role: "assistant", tool_calls: fabricated });
        // Re-route through same processing path
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
          };

          if (!toolFunction || !toolCall?.function) {
            replyTool(`[ERROR]: Tool '${fnName || "unknown"}' not available or arguments invalid.`);
            dbg("Tool missing or invalid:", fnName);
            continue;
          }

          // Args parsen & loggen
          let parsedArgs = {};
          try {
            const raw = toolCall?.function?.arguments || "{}";
            parsedArgs = typeof raw === "string" ? JSON.parse(raw) : (raw || {});
          } catch {
            parsedArgs = {};
          }
          dbg("Execute tool:", fnName, "args:", parsedArgs);

          try {
            const runtime = { channel_id: context_orig.channelId || handoverContext.channelId || null };
            // Hand over as if it were a real tool call
            const toolResult = await toolFunction({ name: fnName, arguments: parsedArgs }, handoverContext, getAIResponse, runtime);

            // DEBUG: Ergebnis-Preview
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
      }

      sequenceCounter++;

      // Continue logic:
      const dueToLength = !hasToolCalls && finishReason === "length";
      if (sequenceLimit <= 1) {
        continueResponse = false;
      } else if (hasToolCalls) {
        // We just added tool outputs; now ask model to continue with them.
        if (sequenceCounter < sequenceLimit) {
          context.messages.push({ role: "user", content: "continue" });
          continueResponse = true;
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

    // === Post-commit (NO user commit here) ===
    // Persist tool outputs (assistant/system) with a sensible timestamp base
    if (toolCommits.length > 0) {
      let t0 = (pendingUser && pendingUser.timestamp) ? pendingUser.timestamp : Date.now();
      for (let i = 0; i < toolCommits.length; i++) {
        const tmsg = toolCommits[i];
        const wrapped = formatToolResultForPersistence(tmsg.name, tmsg.content);
        const persistName = TOOL_PERSIST_ROLE === "assistant" ? "ai" : undefined;
        try {
          await context_orig.add(TOOL_PERSIST_ROLE, persistName, wrapped, t0 + i + 1);
        } catch {
          // ignore persistence errors
        }
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
            contextMessages: (typeof context?.messages !== "undefined") ? context.messages : [],
            handoverMessages: (typeof handoverContext?.messages !== "undefined") ? handoverContext.messages : [],
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

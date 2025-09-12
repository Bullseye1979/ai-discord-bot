// aiCore.js — refactored v2.11 (endpoint override + conditional auth)
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

require("dotenv").config();
const axios = require("axios");
const http = require("http");
const https = require("https");
const { OPENAI_API_URL } = require("./config.js");
const Context = require("./context.js");
const { reportError } = require("./error.js");
const { setBotPresence } = require("./discord-helper.js");

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

/**
 * Run a chat loop with tool-calls and bounded auto-continue.
 * @param {Context} context_orig
 * @param {number}  tokenlimit
 * @param {number}  sequenceLimit
 * @param {string}  model
 * @param {string|null} apiKey
 * @param {object}  options               // { pendingUser?: {name, content, timestamp}, endpoint?: string, noPendingUserInjection?: boolean }
 */
async function getAIResponse(
  context_orig,
  tokenlimit = 4096,
  sequenceLimit = 1000,
  model = "gpt-4o",
  apiKey = null,
  options = {}
) {
  let responseMessage = "";
  const pendingUser = options?.pendingUser || null;
  const noPendingInject = options?.noPendingUserInjection === true;

  try {
    if (tokenlimit == null) tokenlimit = 4096;

    // Working copies (reply context + tool-handover)
    const context = new Context(
      "",
      "",
      context_orig.tools,
      context_orig.toolRegistry,
      context_orig.channelId || null,
      { skipInitialSummaries: true, persistToDB: false }
    );
    context.messages = [...context_orig.messages];

    const handoverContext = new Context(
      "",
      "",
      context_orig.tools,
      context_orig.toolRegistry,
      context_orig.channelId || null,
      { skipInitialSummaries: true, persistToDB: false }
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

      const payload = {
        model,
        messages: messagesToSend,
        max_tokens: tokenlimit,
        tool_choice: "auto",
        tools: context.tools,
      };

      const configuredRaw =
        (options?.endpoint || "").trim() ||
        (process.env.OPENAI_API_URL || "").trim() ||
        (OPENAI_API_URL || "").trim();

      const endpoint =
        normalizeEndpoint(configuredRaw) || "https://api.openai.com/v1/chat/completions";

      const __REQUEST_DEBUG_SNAPSHOT = {
        endpoint,
        model,
        tokenlimit,
        sequenceCounter,
        payloadPreview: {
          messages: messagesToSend,
          tools: Array.isArray(context.tools)
            ? context.tools.map(t => (t?.function?.name || t?.name || "unknown"))
            : [],
        },
        contextMessages: context.messages,
        handoverMessages: handoverContext.messages,
      };

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
        try { console.error("[OPENAI_CHAT][REQUEST_DEBUG]", JSON.stringify(__REQUEST_DEBUG_SNAPSHOT, null, 2)); } catch {}
        console.log("\n\n=== CONTEXT RAW DUMP ===\n", context.messages, "\n=== /CONTEXT RAW DUMP ===\n");
        throw err;
      }

      const choice = aiResponse?.data?.choices?.[0] || {};
      const aiMessage = choice.message || {};
      const finishReason = choice.finish_reason;

      const toolCalls = Array.isArray(aiMessage.tool_calls) ? aiMessage.tool_calls : [];
      const hasToolCalls = toolCalls.length > 0;

      if (hasToolCalls) {
        context.messages.push({ role: "assistant", tool_calls: toolCalls });
      }

      if (typeof aiMessage.content === "string" && aiMessage.content.trim()) {
        responseMessage += aiMessage.content.trim();
      }

      if (hasToolCalls) {
        hadToolCallsThisTurn = true;

        for (const toolCall of toolCalls) {
          const fnName = toolCall?.function?.name;
          setBotPresence(client, "⌛" + fnName, "online");
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
            continue;
          }

          try {
            const runtime = { channel_id: context_orig.channelId || handoverContext.channelId || null };
            const toolResult = await toolFunction(toolCall.function, handoverContext, getAIResponse, runtime);
            replyTool(toolResult || "");
          } catch (toolError) {
            const emsg = toolError?.message || String(toolError);
            await reportError(toolError, null, `TOOL_${(fnName || "unknown").toUpperCase()}`);
            replyTool(JSON.stringify({ error: emsg, tool: fnName || "unknown" }));
          }
        }
      }

      sequenceCounter++;

      const dueToLength = !hasToolCalls && finishReason === "length";
      if (sequenceLimit <= 1) {
        continueResponse = false;
      } else if (dueToLength) {
        if (sequenceCounter < sequenceLimit) {
          if (typeof aiMessage.content === "string" && aiMessage.content.trim()) {
            context.messages.push({ role: "assistant", content: aiMessage.content.trim() });
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
    console.log("\n\n=== CONTEXT OBJ RAW ===\n", context, "\n=== /CONTEXT OBJ RAW ===\n");
    throw err;
  }
}

module.exports = { getAIResponse };

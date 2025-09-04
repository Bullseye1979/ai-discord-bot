// aiCore.js — refactored v2.8 (hardened)
// Chat loop with tool-calls, safe logging, strict auto-continue guard.
// v2.0: pendingUser working-copy + post-commit with original timestamp.
// v2.3: prune orphan historical `tool` msgs when building payload.
// v2.4: PERSIST tool results as `assistant` (or `system`) messages with a clear wrapper.
// v2.5: CAP persisted tool-result wrapper to 3000 chars (config via TOOL_PERSIST_MAX).
// v2.6: Transport hardening (keep-alive + retry) + endpoint normalization.
// v2.7: SIMPLE GLOBAL PRIMING from env -> "General rules:\n{STANDARDPRIMING}" prepended to persona+instructions.
// v2.8: Hardened tool_call flow:
//   - Never push empty tool_calls arrays into context
//   - Only iterate when toolCalls.length > 0
//   - Strict pairing: every assistant.tool_calls is immediately followed by matching tool messages
//   - Safer payload mapping (omit empty/null fields), extra guards

require("dotenv").config();
const fs = require("fs"); // retained for potential future file-priming
const path = require("path");
const axios = require("axios");
const http = require("http");
const https = require("https");
const { OPENAI_API_URL } = require("./config.js");
const Context = require("./context.js");
const { reportError } = require("./error.js");

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
  timeout: 60_000,
  maxRedirects: 0,
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
  validateStatus: (s) => s >= 200 && s < 300,
});

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function postWithRetry(url, payload, headers, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await axiosAI.post(url, payload, { headers });
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
  if (/\/v1\/responses\/?$/.test(url)) return url.replace(/\/v1\/responses\/?$/, "/v1/chat/completions");
  if (/\/v1\/?$/.test(url)) return url.replace(/\/v1\/?$/, "/v1/chat/completions");
  return url;
}

/** Remove orphan historical tool messages; keep only those that pair with a just-previous assistant.tool_calls */
function pruneOrphanToolMessages(msgs) {
  const out = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];

    if (m.role === "tool") {
      const prev = out[out.length - 1];
      const ok =
        prev &&
        prev.role === "assistant" &&
        Array.isArray(prev.tool_calls) &&
        prev.tool_calls.some((tc) => tc && tc.id && tc.id === m.tool_call_id);

      if (!ok) continue; // drop historical/orphan tool message from payload
    }
    out.push(m);
  }
  return out;
}

/* -------------------- Tool result persistence as assistant/system -------------------- */

const TOOL_PERSIST_ROLE =
  (process.env.TOOL_PERSIST_ROLE || "assistant").toLowerCase() === "system" ? "system" : "assistant";

const MAX_TOOL_PERSIST_CHARS = Math.max(
  500,
  10000,
  Math.min(10000, Number(process.env.TOOL_PERSIST_MAX || 3000))
);

/** Produce a compact, parseable wrapper for tool results */
function formatToolResultForPersistence(toolName, content) {
  const header = `[TOOL_RESULT:${(toolName || "unknown").trim()}]`;
  // ensure the payload is a string (raw JSON or text)
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

  // Hard cap to avoid giant blobs (e.g., long PDF text)
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
 * @param {Context} context_orig          // persistent channel context (DB-backed)
 * @param {number}  tokenlimit
 * @param {number}  sequenceLimit
 * @param {string}  model
 * @param {string|null} apiKey
 * @param {object}  options               // { pendingUser?: {name, content, timestamp} }
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

    // Compose system: "General rules:\n{STANDARDPRIMING}" → channel persona → channel instructions
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
    } catch {
      // ignore priming errors
    }

    // Time hint (separate system line)
    const nowUtc = new Date().toISOString();
    context.messages.unshift({
      role: "system",
      content: `Current UTC time: ${nowUtc} <- Use this time whenever asked. Translate to the requested location; if none, use your current location.`,
    });

    // Pending user only in working copy (not yet persisted)
    if (pendingUser && pendingUser.content) {
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

      // do not feed orphan historical tool messages to the API
      const safeMsgs = pruneOrphanToolMessages(context.messages);

      // Map messages for API; omit empty name/tool_calls/tool_call_id
      const messagesToSend = safeMsgs.map((m) => {
        const out = { role: m.role, content: m.content };
        const safeName = cleanOpenAIName(m.role, m.name);
        if (safeName) out.name = safeName;

        if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
          // pass through tool_calls only if non-empty
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

      // Resolve endpoint
      const configured = (process.env.OPENAI_API_URL || OPENAI_API_URL || "").trim();
      const endpoint = normalizeEndpoint(configured) || "https://api.openai.com/v1/chat/completions";

      // === DEBUG SNAPSHOT (wird nur im Fehlerfall ausgegeben) ===
      const __REQUEST_DEBUG_SNAPSHOT = {
        endpoint,
        model,
        tokenlimit,
        sequenceCounter,
        payloadPreview: {
          messages: messagesToSend,
          // Tools nur mit Namen (keine riesigen Strukturen)
          tools: Array.isArray(context.tools)
            ? context.tools.map(t => (t?.function?.name || t?.name || "unknown"))
            : [],
        },
        contextMessages: context.messages,
        handoverMessages: handoverContext.messages,
      };
      // === /DEBUG SNAPSHOT ===

      // API Call (with retry)
      let aiResponse;
      try {
        aiResponse = await postWithRetry(endpoint, payload, {
          Authorization: `Bearer ${authKey}`,
          "Content-Type": "application/json",
          Connection: "keep-alive",
        });
      } catch (err) {
        const details = {
          endpoint,
          status: err?.response?.status,
          data: err?.response?.data,
        };
        await reportError(err, null, "OPENAI_CHAT", { details });

        // ---------------- DEBUG: Kontext & Payload vollständig als JSON ----------------
        try {
          console.error("[OPENAI_CHAT][REQUEST_DEBUG]", JSON.stringify(__REQUEST_DEBUG_SNAPSHOT, null, 2));
        } catch {}
        // --------------------------------------------------------------------------------

        // (Alt) Rohdump, falls du ihn weiterhin sehen willst:
        console.log("\n\n\n\n\n\n\n\n\n\n\n\n\n\n\nCONTEXT: \n *******************************************************************************************\n" + context.messages + "\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n");
        throw err;
      }

      const choice = aiResponse?.data?.choices?.[0] || {};
      const aiMessage = choice.message || {};
      const finishReason = choice.finish_reason;

      const toolCalls = Array.isArray(aiMessage.tool_calls) ? aiMessage.tool_calls : [];
      const hasToolCalls = toolCalls.length > 0;

      // Only push assistant tool_calls if NON-EMPTY
      if (hasToolCalls) {
        context.messages.push({
          role: "assistant",
          tool_calls: toolCalls,
        });
      }

      // Append any assistant content to the aggregated response buffer
      if (typeof aiMessage.content === "string" && aiMessage.content.trim()) {
        responseMessage += aiMessage.content.trim();
      }

      // Tool execution (strict pairing)
      if (hasToolCalls) {
        hadToolCallsThisTurn = true;

        for (const toolCall of toolCalls) {
          const fnName = toolCall?.function?.name;
          const toolFunction = toolRegistry ? toolRegistry[fnName] : undefined;

          const replyTool = (content) => {
            const out =
              typeof content === "string" || content == null
                ? content || ""
                : (() => {
                    try {
                      return JSON.stringify(content);
                    } catch {
                      return String(content);
                    }
                  })();

            context.messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: out,
            });
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

      // Auto-continue only if cut for length and within sequenceLimit
      const dueToLength = !hasToolCalls && finishReason === "length";

      if (sequenceLimit <= 1) {
        continueResponse = false;
      } else if (dueToLength) {
        if (sequenceCounter < sequenceLimit) {
          // If we have content, commit it as assistant content for the next turn
          if (typeof aiMessage.content === "string" && aiMessage.content.trim()) {
            context.messages.push({ role: "assistant", content: aiMessage.content.trim() });
          }
          // Ask the model to continue
          context.messages.push({ role: "user", content: "continue" });
          continueResponse = true;
        } else {
          continueResponse = false;
        }
      } else {
        continueResponse = false;
      }
    } while (hadToolCallsThisTurn || continueResponse);

    // === Post-commit to the persistent context in correct temporal order ===
    // 1) Commit pending user with original timestamp
    if (pendingUser && pendingUser.content) {
      try {
        await context_orig.add(
          "user",
          pendingUser.name || "user",
          pendingUser.content,
          pendingUser.timestamp || Date.now()
        );
      } catch {
        // ignore persistence errors to keep the chat responsive
      }
    }
    // 2) Commit tool outputs right after, anchored to original time (+1ms each), as assistant/system
    if (pendingUser && toolCommits.length > 0) {
      let t0 = pendingUser.timestamp || Date.now();
      for (let i = 0; i < toolCommits.length; i++) {
        const tmsg = toolCommits[i];
        const wrapped = formatToolResultForPersistence(tmsg.name, tmsg.content);
        const persistName = TOOL_PERSIST_ROLE === "assistant" ? "ai" : undefined; // name ignored for system
        try {
          await context_orig.add(TOOL_PERSIST_ROLE, persistName, wrapped, t0 + i + 1);
        } catch {
          // ignore persistence errors
        }
      }
    }

    return responseMessage;
  } catch (err) {
    const details = {
      status: err?.response?.status,
      data: err?.response?.data,
    };
    await reportError(err, null, "GET_AI_RESPONSE", { details });

    // ---------------- DEBUG: kompletter Kontext im Fehlerfall ----------------
    try {
      console.error(
        "[GET_AI_RESPONSE][CONTEXT_DEBUG]",
        JSON.stringify(
          {
            contextMessages: context?.messages || [],
            handoverMessages: handoverContext?.messages || [],
          },
          null,
          2
        )
      );
    } catch {}
    // ------------------------------------------------------------------------

    // (Alt) Rohdump, falls du ihn weiterhin sehen willst:
    console.log("\n\n\n\n\n\n\n\n\n\n\n\n\n\n\nCONTEXT: \n *******************************************************************************************\n" + context + "\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n");

    throw err;
  }
}

module.exports = { getAIResponse };

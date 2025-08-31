// aiCore.js — refactored v2.1
// Chat loop with tool-calls, safe logging, strict auto-continue guard.
// NEW (v2.0): pendingUser working-copy + post-commit of user + tool messages with original timestamp.
// NEW (v2.1): transport hardening (keep-alive + retry + endpoint fallback) + loop guard fix.

require("dotenv").config();
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
  maxRedirects: 0,                 // avoid redirect chains → "socket hang up"
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
  validateStatus: (s) => s >= 200 && s < 300,
});

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
      await new Promise((r) => setTimeout(r, 300 * Math.pow(2, i))); // 300ms, 600ms, 1200ms
    }
  }
  throw lastErr;
}

/* ---------------------------------------------------------------------------------- */

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

    // Working copies (reply context + tool-handover), MUST carry channelId for tools like getHistory
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

    // If we have a pending user-turn, PUT IT ONLY INTO THE WORKING COPY (not into context_orig yet!)
    if (pendingUser && pendingUser.content) {
      const safeName = cleanOpenAIName("user", pendingUser.name || "user");
      const msg = { role: "user", content: pendingUser.content };
      if (safeName) msg.name = safeName;
      context.messages.push(msg);
      handoverContext.messages.push({ ...msg }); // tools may peek the same working sequence
    }

    const toolCommits = []; // { name: fnName, content: string }
    let continueResponse = false;
    let sequenceCounter = 0;

    const authKey = apiKey || process.env.OPENAI_API_KEY;

    // loop until tools are resolved (per-turn) or a 'continue' chain is finished
    let hasToolCalls = false;
    do {
      const messagesToSend = context.messages.map((m) => {
        const out = { role: m.role, content: m.content };
        const safeName = cleanOpenAIName(m.role, m.name);
        if (safeName) out.name = safeName;
        if (m.tool_calls) out.tool_calls = m.tool_calls;
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

      // Endpoint sanity: fallback to official chat completions if env/config is missing
      const endpoint =
        (process.env.OPENAI_API_URL || OPENAI_API_URL || "").trim() ||
        "https://api.openai.com/v1/chat/completions";

      // API Call (with retry)
      let aiResponse;
      try {
        aiResponse = await postWithRetry(endpoint, payload, {
          Authorization: `Bearer ${authKey}`,
          "Content-Type": "application/json",
          Connection: "keep-alive",
        });
      } catch (err) {
        await reportError(err, null, "OPENAI_CHAT");
        throw err;
      }

      const choice = aiResponse.data.choices[0];
      const aiMessage = choice.message;
      const finishReason = choice.finish_reason;

      hasToolCalls = !!(aiMessage.tool_calls && aiMessage.tool_calls.length > 0);

      if (aiMessage.tool_calls) {
        context.messages.push({
          role: "assistant",
          tool_calls: aiMessage.tool_calls || null,
        });
      }

      if (aiMessage.content) {
        responseMessage += (aiMessage.content || "").trim();
      }

      // Tool execution
      if (hasToolCalls) {
        for (const toolCall of aiMessage.tool_calls) {
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
            // record for commit later
            toolCommits.push({ name: fnName || "tool", content: out });
          };

          if (!toolFunction) {
            const msg = `[ERROR]: Tool '${fnName}' not available or arguments invalid.`;
            replyTool(msg);
            continue;
          }

          try {
            // Runtime with channel_id for getHistory etc.
            const runtime = {
              channel_id: context_orig.channelId || handoverContext.channelId || null,
            };
            const toolResult = await toolFunction(
              toolCall.function,
              handoverContext,
              getAIResponse,
              runtime
            );
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
          if ((aiMessage.content || "").trim()) {
            context.messages.push({ role: "assistant", content: (aiMessage.content || "").trim() });
          }
          context.messages.push({ role: "user", content: "continue" });
          continueResponse = true;
        } else {
          continueResponse = false;
        }
      } else {
        continueResponse = false;
      }
    } while (hasToolCalls || continueResponse); // <= FIX: evaluate per-iteration result, not a sticky flag

    // === Post-commit to the persistent context in correct temporal order ===
    // 1) The pending user message (always commit it), with original timestamp
    if (pendingUser && pendingUser.content) {
      try {
        await context_orig.add(
          "user",
          pendingUser.name || "user",
          pendingUser.content,
          pendingUser.timestamp || Date.now()
        );
      } catch {}
    }
    // 2) If tools ran, commit their outputs right after, anchored near original time (+1ms per tool)
    if (pendingUser && toolCommits.length > 0) {
      let t0 = pendingUser.timestamp || Date.now();
      for (let i = 0; i < toolCommits.length; i++) {
        const tmsg = toolCommits[i];
        try {
          await context_orig.add("tool", tmsg.name || "tool", tmsg.content, t0 + i + 1);
        } catch {}
      }
    }

    return responseMessage;
  } catch (err) {
    await reportError(err, null, "GET_AI_RESPONSE");
    throw err;
  }
}

module.exports = { getAIResponse };

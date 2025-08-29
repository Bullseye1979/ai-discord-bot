// aiCore.js — clean v1.7
// Chat loop with tool-calls, safe logging, strict auto-continue guard.

require("dotenv").config();
const axios = require("axios");
const { OPENAI_API_URL } = require("./config.js");
const Context = require("./context.js");

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

/** Log axios errors without leaking secrets */
function logAxiosErrorSafe(prefix, err) {
  const redactAuth = (h = {}) => {
    const out = { ...h };
    if (out.authorization) out.authorization = "Bearer ***";
    if (out.Authorization) out.Authorization = "Bearer ***";
    return out;
  };
  const msg = err?.message || String(err);
  console.error(prefix, msg);
  if (err?.response) {
    try {
      const cfg = err.response.config || {};
      console.error(`${prefix} Response:`, {
        status: err.response.status,
        statusText: err.response.statusText,
        headers: redactAuth(err.response.headers),
        data: err.response.data,
        config: {
          method: cfg.method,
          url: cfg.url,
          headers: cfg.headers ? redactAuth(cfg.headers) : undefined,
        },
      });
    } catch (e) {
      console.error(`${prefix} (while masking)`, e?.message || e);
    }
  }
}

/**
 * Run a chat loop with tool-calls and bounded auto-continue.
 * @param {Context} context_orig
 * @param {number} tokenlimit
 * @param {number} sequenceLimit
 * @param {string} model
 * @param {string|null} apiKey
 */
async function getAIResponse(
  context_orig,
  tokenlimit = 4096,
  sequenceLimit = 1000,
  model = "gpt-4o",
  apiKey = null
) {
  if (tokenlimit == null) tokenlimit = 4096;

  const context = new Context("", "", context_orig.tools, context_orig.toolRegistry);
  context.messages = [...context_orig.messages];

  const handoverContext = new Context("", "", context_orig.tools, context_orig.toolRegistry);
  handoverContext.messages = [...context_orig.messages];

  const toolRegistry = context.toolRegistry;

  try {
    const sysParts = [];
    if ((context_orig.persona || "").trim()) sysParts.push(String(context_orig.persona).trim());
    if ((context_orig.instructions || "").trim()) sysParts.push(String(context_orig.instructions).trim());
    const sysCombined = sysParts.join("\n\n").trim();
    if (sysCombined) {
      context.messages.unshift({ role: "system", content: sysCombined });
    }
  } catch {}

  const nowUtc = new Date().toISOString();
  context.messages.unshift({
    role: "system",
    content: `Current UTC time: ${nowUtc} <- Use this time whenever asked. Translate to the requested location; if none, use your current location.`
  });

  let responseMessage = "";
  let hasToolCalls = false;
  let continueResponse = false;
  let sequenceCounter = 0;

  const authKey = apiKey || process.env.OPENAI_API_KEY;

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

    try {
      console.log("── getAIResponse → payload (preview) ──");
      console.log(
        JSON.stringify(
          {
            model,
            max_tokens: tokenlimit,
            tools: (context.tools || []).map((t) => t.function?.name),
            messages_preview: messagesToSend.map((m) => ({
              role: m.role,
              name: m.name,
              content:
                (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 400),
            })),
          },
          null,
          2
        )
      );
    } catch {}

    let aiResponse;
    try {
      aiResponse = await axios.post(OPENAI_API_URL, payload, {
        headers: { Authorization: `Bearer ${authKey}`, "Content-Type": "application/json" },
      });

      try {
        const meta = {
          created: aiResponse.data?.created,
          model: aiResponse.data?.model,
          finish_reason: aiResponse.data?.choices?.[0]?.finish_reason,
          has_tool_calls: !!aiResponse.data?.choices?.[0]?.message?.tool_calls,
        };
        console.log("getAIResponse ← OpenAI meta:", meta);
      } catch {}
    } catch (err) {
      logAxiosErrorSafe("[FATAL] OpenAI chat error:", err);
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

      try {
        console.log(
          "ToolCalls:",
          aiMessage.tool_calls.map((tc) => ({
            id: tc.id,
            name: tc.function?.name,
            args: tc.function?.arguments,
          }))
        );
      } catch {}
    }

    if (aiMessage.content) {
      responseMessage += (aiMessage.content || "").trim();
    }

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
        };

        if (!toolFunction) {
          const msg = `[ERROR]: Tool '${fnName}' not available or arguments invalid.`;
          console.error(msg);
          replyTool(msg);
          continue;
        }

        try {
          console.log("Execute Tool:", { tool: fnName, args: toolCall.function?.arguments });
          const toolResult = await toolFunction(toolCall.function, handoverContext, getAIResponse);
          console.log(
            "Tool Result (first 400 chars):",
            typeof toolResult === "string" ? toolResult.slice(0, 400) : toolResult
          );
          replyTool(toolResult || "");
        } catch (toolError) {
          const emsg = toolError?.message || String(toolError);
          console.error(`[ERROR] Tool execution failed for '${fnName}':`, emsg);
          replyTool({ error: emsg, tool: fnName });
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
  } while (hasToolCalls || continueResponse);

  return responseMessage;
}

module.exports = { getAIResponse };

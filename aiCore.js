// aiCore.js — fixed voice+tool flow, safe names + content
// - Keeps your existing tool-call formatting intact (we pass through the tools array as-is)
// - Rejects invalid message.name (spaces etc.) when sending to OpenAI (prevents 400s)
// - Never sends `null` content to OpenAI; coerces to "" where needed
// - Returns a plain string (assistant text), as discord-handler expects
// - Supports tool-call loop (assistant -> tools -> assistant)
//
// Exports:
//   getAIResponse(context, tokenlimit=4096, sequenceLimit=1000, model="gpt-4-turbo", apiKey=null)

const axios = require("axios");
const { tools, getToolRegistry } = require("./tools.js");

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const VALID_NAME = /^[^\s<|\\/>]+$/;

// Convert any content shape into a flat string for OpenAI / for our return value
function asText(c) {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    // handle potential array-of-parts formats defensively
    return c.map(p => {
      if (typeof p === "string") return p;
      if (p && typeof p.text === "string") return p.text;
      return "";
    }).join("");
  }
  try { return String(c); } catch { return ""; }
}

// Build a safe messages array for OpenAI
function buildOpenAIMessages(context, limit) {
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  const seq = (Number.isFinite(limit) && limit > 0)
    ? messages.slice(-limit)
    : messages.slice();

  return seq.map(m => {
    const out = {
      role: m.role,
      // IMPORTANT: never send null; always coerce to string
      content: asText(m.content)
    };
    if (m.name && VALID_NAME.test(String(m.name))) {
      out.name = m.name;
    }
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    return out;
  });
}

// Execute a single tool by name using the registry
async function runToolCall(call, registry, channelId) {
  try {
    const fn = call?.function?.name;
    const args = call?.function?.arguments;
    if (!fn || !registry || typeof registry[fn]?.handler !== "function") {
      return { ok: false, text: `Tool ${fn || "<unknown>"} not available.` };
    }
    let parsedArgs = {};
    try {
      parsedArgs = args && typeof args === "string" ? JSON.parse(args) : (args || {});
    } catch {
      // pass raw args string if JSON.parse failed
      parsedArgs = { __raw: String(args) };
    }
    const res = await registry[fn].handler(parsedArgs, channelId);
    const out = (res && typeof res === "object" && "content" in res) ? res.content : res;
    return { ok: true, text: asText(out) };
  } catch (e) {
    return { ok: false, text: `Tool error: ${e?.message || e}` };
  }
}

async function openAIChat(payload, apiKey) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OpenAI API key");
  const res = await axios.post(OPENAI_URL, payload, {
    timeout: 30000,
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "Accept": "application/json"
    }
  });
  return res?.data;
}

async function getAIResponse(context_orig, tokenlimit = 4096, sequenceLimit = 1000, model = "gpt-4-turbo", apiKey = null) {
  // Clone & ensure tool registry
  const context = {
    ...context_orig,
    messages: Array.isArray(context_orig?.messages) ? [...context_orig.messages] : [],
    toolRegistry: context_orig?.toolRegistry || getToolRegistry((context_orig?.tools || tools).map(t => t.function.name)).registry,
    tools: (context_orig?.tools && context_orig.tools.length ? context_orig.tools : tools)
  };

  // Build messages for first call
  const messages = buildOpenAIMessages(context, sequenceLimit);

  // Prepare payload with tools exactly as defined
  const payloadBase = {
    model,
    messages,
    max_tokens: tokenlimit,
    tool_choice: "auto",
    tools: context.tools
  };

  // 1) First call
  let data;
  try {
    data = await openAIChat(payloadBase, apiKey);
  } catch (e) {
    // Bubble up rich error for the caller to log
    if (e?.response?.data) {
      console.error(JSON.stringify(e.response.data, null, 2));
    }
    throw e;
  }

  const firstMsg = data?.choices?.[0]?.message || {};
  const firstContent = asText(firstMsg.content);
  let finalText = firstContent;

  // If the model emitted tool calls, run them and then ask again
  const toolCalls = Array.isArray(firstMsg.tool_calls) ? firstMsg.tool_calls : [];

  if (toolCalls.length > 0) {
    // Put the assistant message with tool_calls into our running context
    context.messages.push({
      role: "assistant",
      content: firstContent,           // keep any assistant text that came with the tool_calls (often empty)
      tool_calls: toolCalls
    });

    // Execute each tool, push results
    for (const call of toolCalls) {
      const { ok, text } = await runToolCall(call, context.toolRegistry, context_orig?.channelId || null);
      context.messages.push({
        role: "tool",
        name: call?.function?.name || undefined,
        tool_call_id: call?.id,
        content: asText(text)
      });
    }

    // 2) Second call with tool results
    const followup = {
      model,
      messages: buildOpenAIMessages(context, sequenceLimit),
      max_tokens: tokenlimit,
      tool_choice: "none",
      tools: context.tools
    };

    let data2;
    try {
      data2 = await openAIChat(followup, apiKey);
    } catch (e) {
      if (e?.response?.data) {
        console.error(JSON.stringify(e.response.data, null, 2));
      }
      throw e;
    }
    const secondMsg = data2?.choices?.[0]?.message || {};
    finalText = asText(secondMsg.content);
  }

  // Return plain string (discord-handler expects .trim() to work)
  return asText(finalText).trim();
}

module.exports = { getAIResponse };

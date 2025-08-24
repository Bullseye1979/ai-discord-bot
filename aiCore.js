// aiCore.js — safe tool loop + name/content sanitizing for chat.completions
const axios = require("axios");

/** matches allowed pattern: ^[^\s<|\\/>]+$  */
const NAME_OK = /^[^\s<|\\/>]+$/;

/** turn any display name into an API-safe token or return undefined to drop it */
function sanitizeName(maybeName) {
  if (!maybeName) return undefined;
  let s = String(maybeName)
    // strip angle/pipe/slash/backslash
    .replace(/[<|\\/>\u200B-\u200D\uFEFF]/g, "")
    // spaces -> underscore
    .replace(/\s+/g, "_")
    // remove other weird whitespace
    .trim();

  // if still bad, brute-clean to [A-Za-z0-9_-]
  if (!NAME_OK.test(s)) {
    s = s.replace(/[^\w-]/g, "");
  }
  // length clamp (OpenAI docs limit name to 64 chars typically)
  if (s.length > 64) s = s.slice(0, 64);

  if (!s || !NAME_OK.test(s)) return undefined;
  return s;
}

/** ensure message.content is a string if present; if it's null and role=assistant with tool_calls → make it "" */
function fixContentShape(msg) {
  if (msg == null || typeof msg !== "object") return msg;
  // Tool outputs MUST be string
  if (msg.role === "tool") {
    if (msg.content == null) msg.content = "";
    if (typeof msg.content !== "string") {
      try { msg.content = JSON.stringify(msg.content); } catch { msg.content = String(msg.content); }
    }
    return msg;
  }
  // Assistant with tool_calls may come back with content:null → set to empty string
  if (msg.role === "assistant" && msg.content == null) {
    msg.content = "";
  }
  // For all others: if content exists but is not string, coerce
  if (msg.content != null && typeof msg.content !== "string") {
    try { msg.content = JSON.stringify(msg.content); } catch { msg.content = String(msg.content); }
  }
  return msg;
}

/** clone + sanitize one message */
function sanitizeMessage(m) {
  const msg = { ...m };

  // role is required by API; keep as is
  // name is optional; only keep if valid after sanitize
  if (msg.name != null) {
    const cleaned = sanitizeName(msg.name);
    if (cleaned) msg.name = cleaned; else delete msg.name;
  }

  // content shape
  fixContentShape(msg);

  // tool role: ensure tool_call_id present if you use tool messages
  // (we don't force it; we just pass through whatever ctx built)

  return msg;
}

/** sanitize the whole messages array */
function buildCleanMessages(rawMessages) {
  if (!Array.isArray(rawMessages)) return [];
  return rawMessages
    .filter(m => m && typeof m.role === "string") // keep only valid
    .map(sanitizeMessage);
}

/**
 * Execute local tool by name using provided registry.
 * The registry is expected to be { [toolName]: async (args) => string|object }.
 */
async function runLocalTool(toolRegistry, name, args) {
  const fn = toolRegistry && toolRegistry[name];
  if (!fn) {
    return JSON.stringify({ error: `Tool '${name}' not found` });
  }
  try {
    const res = await fn(args || {});
    if (typeof res === "string") return res;
    return JSON.stringify(res);
  } catch (e) {
    return JSON.stringify({ error: String(e && e.message || e) });
  }
}

/**
 * Main entry used everywhere else.
 * Keep signature as used in your code: getAIResponse(ctx, maxTokens, temperature, model, apiKey)
 */
async function getAIResponse(ctx, maxTokens = 4096, temperature = 0.7, model = "gpt-4o", apiKey) {
  if (!apiKey) throw new Error("Missing OpenAI API key");

  // ---- 1) Collect messages from ctx the way your code already does ----
  // If your Context has a method (e.g. getContext()), prefer that:
  let baseMessages = Array.isArray(ctx?.messages) ? ctx.messages : [];
  // If you actually use a method, uncomment the next lines and adapt:
  // if (typeof ctx.getContext === "function") {
  //   baseMessages = await ctx.getContext();
  // }

  const messages = buildCleanMessages(baseMessages);

  // Tools (as you already format them elsewhere)
  const tools = Array.isArray(ctx?.tools) ? ctx.tools : undefined;
  const toolRegistry = ctx?.toolRegistry || {};

  const client = axios.create({
    baseURL: "https://api.openai.com/v1",
    timeout: 30000,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  // Helper to call chat.completions once
  async function callOnce(msgs) {
    const body = {
      model,
      messages: msgs,
      max_tokens: maxTokens,
      // keep your exact fields/format:
      ...(tools && tools.length ? { tools, tool_choice: "auto" } : {}),
    };

    const { data } = await client.post("/chat/completions", body);
    return data;
  }

  // ---- 2) Initial call ----
  let working = messages.slice();
  let data = await callOnce(working);

  // ---- 3) Tool loop (max 5 hops) ----
  for (let hop = 0; hop < 5; hop++) {
    const choice = data?.choices?.[0];
    if (!choice) break;

    const assistantMsg = choice.message || {};
    // Normalize content shape to dodge "content must be string"
    fixContentShape(assistantMsg);

    const toolCalls = assistantMsg.tool_calls || assistantMsg.toolCalls || null;

    if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
      // no tool calls → final
      return {
        text: assistantMsg.content || "",
        raw: data,
      };
    }

    // Push the assistant message with tool_calls (and content:"")
    working.push({
      role: "assistant",
      content: assistantMsg.content || "",
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: "function",
        function: { name: tc.function?.name, arguments: tc.function?.arguments }
      })),
    });

    // Execute each tool, push tool results
    for (const tc of toolCalls) {
      const toolName = tc?.function?.name;
      let args = {};
      try { args = tc?.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch {}
      const result = await runLocalTool(toolRegistry, toolName, args);

      working.push({
        role: "tool",
        tool_call_id: tc.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
        // DO NOT set name on tool messages (avoid name pattern issues)
      });
    }

    // Next round
    data = await callOnce(working);
  }

  // safety return
  const finalChoice = data?.choices?.[0]?.message;
  return {
    text: (finalChoice && (finalChoice.content || "")) || "",
    raw: data,
  };
}

module.exports = {
  getAIResponse,
};

// aiCore.js
const axios = require("axios");

// ---- Helper: Name säubern (API erlaubt keine Spaces/Sonderzeichen) ----
function sanitizeName(name) {
  if (typeof name !== "string") return undefined;
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return safe || undefined;
}

// ---- Helper: Messages für OpenAI bereinigen ----
function sanitizeMessagesForOpenAI(messages = []) {
  const allowedRoles = new Set(["system", "user", "assistant", "tool"]);
  const out = [];

  for (const m of messages) {
    if (!m || !allowedRoles.has(m.role)) continue;

    // content immer als String (oder für tool später gesetzt)
    let content = m.content;
    if (Array.isArray(content)) {
      content = content.map(x => (typeof x === "string" ? x : JSON.stringify(x))).join("");
    }
    if (content == null) content = ""; // <- WICHTIG gegen "content: null"

    const item = { role: m.role, content };

    // "name" NUR bei user erlaubt und ohne verbotene Zeichen
    if (m.role === "user") {
      const safe = sanitizeName(m.name);
      if (safe) item.name = safe;
    }

    // Tool-call-Assistant: wir akzeptieren tool_calls, aber NIEMALS null content
    if (m.role === "assistant" && m.tool_calls) {
      item.tool_calls = m.tool_calls.map(tc => ({
        id: tc.id,
        type: "function",
        function: { name: tc.function?.name, arguments: String(tc.function?.arguments || "{}") }
      }));
      if (item.content == null) item.content = "";
    }

    // Tool-Result: nur übernehmen, wenn tool_call_id da ist
    if (m.role === "tool" && m.tool_call_id) {
      item.tool_call_id = String(m.tool_call_id);
      // content bleibt String (oben bereits gesichert)
    }

    out.push(item);
  }
  return out;
}

// ---- Tool-Ausführung: aus assistant.tool_calls -> tool role messages bauen ----
async function runToolCallsOnce({ openAIRequestBase, assistantMsg, toolRegistry }) {
  const toolCalls = assistantMsg?.tool_calls || [];
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;

  const toolResults = [];
  for (const tc of toolCalls) {
    const fname = tc?.function?.name;
    const fargsRaw = tc?.function?.arguments || "{}";
    let argsObj = {};
    try { argsObj = JSON.parse(fargsRaw); } catch {}
    let result;
    try {
      const fn = toolRegistry?.[fname];
      if (typeof fn !== "function") {
        result = `{"error":"Unknown tool '${fname}'"}`;
      } else {
        const r = await fn(argsObj);
        result = (typeof r === "string") ? r : JSON.stringify(r);
      }
    } catch (e) {
      result = JSON.stringify({ error: String(e?.message || e) });
    }
    toolResults.push({
      role: "tool",
      content: result,
      tool_call_id: tc.id || `${fname}_${Date.now()}`
    });
  }

  // Neues Request: bisherige Messages + assistant (mit tool_calls) + tool-results
  const followUp = {
    ...openAIRequestBase,
    messages: sanitizeMessagesForOpenAI([
      ...openAIRequestBase.messages,
      { role: "assistant", content: "", tool_calls: assistantMsg.tool_calls },
      ...toolResults
    ])
  };
  return followUp;
}

// ---- Hauptfunktion: Chat + Tools robust ----
async function getAIResponse(ctx, maxTokens = 800, model = "gpt-4o", overrideTools, overrideToolRegistry) {
  const tools = Array.isArray(overrideTools ?? ctx.tools) ? (overrideTools ?? ctx.tools) : [];
  const toolRegistry = overrideToolRegistry ?? ctx.toolRegistry ?? {};

  // Basis-Request bauen
  const base = {
    model,
    max_tokens: maxTokens,
    messages: sanitizeMessagesForOpenAI(ctx.messages || [])
  };

  // Tools nur mitsenden, wenn vorhanden
  if (tools.length > 0) {
    base.tools = tools;
    base.tool_choice = "auto";
  }

  // 1. Call
  let req = base;
  for (let hop = 0; hop < 4; hop++) { // bis zu 4 Tool-Hops
    const { data } = await axios.post("https://api.openai.com/v1/chat/completions", req, {
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 30000
    });

    const choice = data?.choices?.[0];
    const msg = choice?.message || {};
    const finish = choice?.finish_reason;

    // Toolcalls?
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      // Folge-Request mit tool role messages
      const nextReq = await runToolCallsOnce({
        openAIRequestBase: req,
        assistantMsg: msg,
        toolRegistry
      });
      if (!nextReq) break; // Sicherheitsnetz
      req = nextReq;
      continue; // nächster Hop
    }

    // Kein Toolcall → finaler Text
    const text = (msg.content || "").trim();
    return {
      text,
      raw: data
    };
  }

  // Fallback wenn wir hier landen
  return { text: "", raw: null };
}

module.exports = {
  getAIResponse
};

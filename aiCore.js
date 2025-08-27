// aiCore.js — v1.6
// Chat-Loop mit Tool-Calls (robust) + DEBUG-Logs
require('dotenv').config();
const axios = require('axios');
const { OPENAI_API_URL } = require('./config.js');
const Context = require('./context.js');

/** Name-Sanitizing gemäß OpenAI (^ [^\s<|\\/>]+ $); löscht KEINE Messages, fasst nur name an */
function cleanOpenAIName(role, name) {
  if (!name) return undefined;
  // Für system/tool kein Name senden
  if (role === "system" || role === "tool") return undefined;

  let s = String(name)
    .trim()
    .replace(/[\s<|\\/>\u0000-\u001F]/g, "_") // Whitespace/Steuerz./<|\ />
    .replace(/[^A-Za-z0-9._-]/g, "_")          // Whitelist
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  s = s.slice(0, 64);
  if (!s) return undefined;

  const reserved = new Set(["assistant", "user", "system", "tool"]);
  if (reserved.has(s.toLowerCase())) return undefined;

  return s;
}

/** Sichere Axios-Fehlerausgabe (keine Tokens leaken) */
function logAxiosErrorSafe(prefix, err) {
  const msg = err?.message || String(err);
  console.error(prefix, msg);
  if (err?.response) {
    try {
      const safeHeaders = { ...err.response.headers };
      if (safeHeaders.authorization) safeHeaders.authorization = "Bearer ***";
      const cfg = err.response.config || {};
      const safeCfg = {
        method: cfg.method,
        url: cfg.url,
        headers: cfg.headers ? { ...cfg.headers, Authorization: "Bearer ***" } : undefined
      };
      console.error(`${prefix} Response:`, {
        status: err.response.status,
        statusText: err.response.statusText,
        headers: safeHeaders,
        data: err.response.data,
        config: safeCfg
      });
    } catch (e) {
      console.error(`${prefix} (while masking)`, e);
    }
  }
}

/**
 * Hauptloop
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

  // Arbeitskontexte
  const context = new Context("", "", context_orig.tools, context_orig.toolRegistry);
  context.messages = [...context_orig.messages];

  const handoverContext = new Context("", "", context_orig.tools, context_orig.toolRegistry);
  handoverContext.messages = [...context_orig.messages];

  const toolRegistry = context.toolRegistry;

  // Zeitkontext vorn anstellen
  const nowUtc = new Date().toISOString();
  context.messages.unshift({
    role: "system",
    content: `Current UTC time: ${nowUtc} <- Use this time, whenever you are asked for the current time. Translate it to the location for which the time is requested. If no location is specified use your current location.`
  });

  let responseMessage = "";
  let hasToolCalls = false;
  let continueResponse = false;
  let sequenceCounter = 0;

  const authKey = apiKey || process.env.OPENAI_API_KEY;

  do {
    // Messages serialisieren (nur gültige Felder; name sicher bereinigt)
    const messagesToSend = context.messages.map(m => {
      const out = { role: m.role, content: m.content };
      const safeName = cleanOpenAIName(m.role, m.name);
      if (safeName) out.name = safeName;
      if (m.tool_calls)  out.tool_calls  = m.tool_calls;
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      return out;
    });

    const payload = {
      model,
      messages: messagesToSend,
      max_tokens: tokenlimit,
      tool_choice: "auto",
      tools: context.tools
    };

    // DEBUG: kompaktes Preview
    try {
      console.log("──────────────── DEBUG:getAIResponse → OpenAI Payload ────────────────");
      console.log(JSON.stringify({
        model,
        max_tokens: tokenlimit,
        tools: (context.tools || []).map(t => t.function?.name),
        messages_preview: messagesToSend.map(m => ({
          role: m.role,
          name: m.name,
          content: (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 400)
        }))
      }, null, 2));
      console.log("──────────────────────────────────────────────────────────────────────");
    } catch { /* ignore */ }

    let aiResponse;
    try {
      aiResponse = await axios.post(OPENAI_API_URL, payload, {
        headers: { Authorization: `Bearer ${authKey}`, "Content-Type": "application/json" }
      });

      // DEBUG: Antwort-Meta
      try {
        const meta = {
          created: aiResponse.data?.created,
          model: aiResponse.data?.model,
          finish_reason: aiResponse.data?.choices?.[0]?.finish_reason,
          has_tool_calls: !!aiResponse.data?.choices?.[0]?.message?.tool_calls
        };
        console.log("DEBUG:getAIResponse ← OpenAI Meta:", meta);
      } catch { /* ignore */ }
    } catch (err) {
      logAxiosErrorSafe("[FATAL] Error from OpenAI:", err);
      throw err;
    }

    const choice = aiResponse.data.choices[0];
    const aiMessage = choice.message;
    const finishReason = choice.finish_reason;

    hasToolCalls = !!(aiMessage.tool_calls && aiMessage.tool_calls.length > 0);

    // Assistant macht Tool-Calls?
    if (aiMessage.tool_calls) {
      context.messages.push({
        role: "assistant",
        tool_calls: aiMessage.tool_calls || null
      });

      // DEBUG: Registry/Tools sichtbar machen
      try {
        console.log("DEBUG: toolRegistry keys:", Object.keys(toolRegistry || {}));
        console.log("DEBUG: ToolCalls received:", aiMessage.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function?.name,
          args: tc.function?.arguments
        })));
      } catch { /* ignore */ }
    }

    // Freitext anhängen (falls vorhanden)
    if (aiMessage.content) {
      responseMessage += (aiMessage.content || "").trim();
    }

    // Tool-Calls ausführen — robust: immer ein tool-Reply zurückschreiben
    if (hasToolCalls) {
      for (const toolCall of aiMessage.tool_calls) {
        const fnName = toolCall?.function?.name;
        const toolFunction = toolRegistry ? toolRegistry[fnName] : undefined;

        // Helper: auch im Fehlerfall eine gültige tool-Message anfügen
        const replyTool = (content) => {
          const out = (typeof content === "string" || content == null)
            ? (content || "")
            : (() => { try { return JSON.stringify(content); } catch { return String(content); } })();

          context.messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: out
          });
        };

        if (!toolFunction) {
          const msg = `[ERROR]: Tool '${fnName}' not available or arguments invalid.`;
          console.error(msg);
          replyTool(msg);
          continue;
        }

        try {
          // DEBUG: Tool-Aufruf
          console.log("DEBUG: Execute Tool:", { tool: fnName, args: toolCall.function?.arguments });
          const toolResult = await toolFunction(toolCall.function, handoverContext, getAIResponse);

          // DEBUG: Tool-Result (gekürzt)
          console.log(
            "DEBUG: Tool Result (first 400 chars):",
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

    // ================== Auto-Continue sicher begrenzen ==================
    // diesen Durchlauf zählen (Text-Antwort-Schritt)
    sequenceCounter++;

    // Nur wenn wegen Tokenlänge abgebrochen wurde und KEINE Tools im Spiel sind
    const dueToLength = (!hasToolCalls && finishReason === "length");

    if (sequenceLimit <= 1) {
      // z.B. Voice: Niemals "continue" pushen
      continueResponse = false;
    } else if (dueToLength) {
      if (sequenceCounter < sequenceLimit) {
        // (Optional, aber sauber): abgeschnittene Antwort in den Verlauf hängen
        if ((aiMessage.content || "").trim()) {
          context.messages.push({ role: "assistant", content: (aiMessage.content || "").trim() });
        }
        // genau EIN continue anfügen
        context.messages.push({ role: "user", content: "continue" });
        continueResponse = true;
      } else {
        // Limit erreicht → kein continue mehr
        continueResponse = false;
      }
    } else {
      continueResponse = false;
    }

  } while (hasToolCalls || continueResponse);

  return responseMessage;
}

module.exports = { getAIResponse };
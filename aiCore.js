// aiCore.js — Version 1.5 (DEBUG + sichere name-Sanitization, tool_calls unverändert)
require('dotenv').config();
const axios = require('axios');
const { OPENAI_API_URL } = require('./config.js');
const Context = require('./context.js');

// Hilfsfunktion: Name säubern oder weglassen (konform zu OpenAI: ^[^\s<|\\/>]+$)
function cleanOpenAIName(role, name) {
  if (!name) return undefined;
  // Für system/tool nie "name" mitsenden
  if (role === "system" || role === "tool") return undefined;

  let s = String(name)
    .trim()
    // Whitespace + verbotene Steuerzeichen + < | \ / > -> Unterstrich
    .replace(/[\s<|\\/>\u0000-\u001F]/g, "_")
    // Alle anderen Nicht-Whitelist-Zeichen -> Unterstrich
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");

  s = s.slice(0, 64);
  if (!s) return undefined;

  const reserved = new Set(["assistant", "user", "system", "tool"]);
  if (reserved.has(s.toLowerCase())) return undefined;

  return s;
}

// Sichere Fehlerausgabe (Authorization-Header maskiert)
function logAxiosErrorSafe(prefix, err) {
  const msg = err?.message || String(err);
  console.error(prefix, msg);
  if (err.response) {
    try {
      // Response ohne Token leaken
      const safeHeaders = { ...err.response.headers };
      if (safeHeaders.authorization) safeHeaders.authorization = "Bearer ***";
      const safeConfig = { ...err.response.config };
      if (safeConfig?.headers?.Authorization) {
        safeConfig.headers = { ...safeConfig.headers, Authorization: "Bearer ***" };
      }
      console.error(`${prefix} Response:`, {
        status: err.response.status,
        statusText: err.response.statusText,
        headers: safeHeaders,
        data: err.response.data,
        config: {
          method: safeConfig.method,
          url: safeConfig.url
        }
      });
    } catch (e) {
      console.error(`${prefix} (while masking)`, e);
    }
  }
}

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

  // Zeitkontext
  const nowUtc = new Date().toISOString();
  context.messages.unshift({
    role: "system",
    content:
      "Current UTC time: " +
      nowUtc +
      " <- Use this time, whenever you are asked for the current time. Translate it to the location for which the time is requested. If no location is specified use your current location."
  });

  let responseMessage = "";
  let hasToolCalls = false;
  let continueResponse = false;
  let lastmessage = 0;
  let sequenceCounter = 0;

  const authKey = apiKey || process.env.OPENAI_API_KEY;

  do {
    // Nachrichten an die API (nur gültige Felder; name wird sicher bereinigt)
    const messagesToSend = context.messages.map((m) => {
      const out = { role: m.role, content: m.content };
      const safeName = cleanOpenAIName(m.role, m.name);
      if (safeName) out.name = safeName;
      if (m.tool_calls) out.tool_calls = m.tool_calls;
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      return out;
    });

    const payload = {
      model: model,
      messages: messagesToSend,
      max_tokens: tokenlimit,
      tool_choice: "auto",
      tools: context.tools
    };

    // DEBUG: Was geht an die KI (kompakte Vorschau)
    try {
      console.log("──────────────── DEBUG:getAIResponse → OpenAI Payload ────────────────");
      console.log(
        JSON.stringify(
          {
            model,
            max_tokens: tokenlimit,
            tools: (context.tools || []).map((t) => t.function?.name),
            messages_preview: messagesToSend.map((m) => ({
              role: m.role,
              name: m.name,
              content: (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 400)
            }))
          },
          null,
          2
        )
      );
      console.log("──────────────────────────────────────────────────────────────────────");
    } catch {
      /* ignore */
    }

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
      } catch {
        /* ignore */
      }
    } catch (err) {
      logAxiosErrorSafe("[FATAL] Error from OpenAI:", err);
      throw err;
    }

    const choice = aiResponse.data.choices[0];
    const aiMessage = choice.message;
    const finishReason = choice.finish_reason;

    hasToolCalls = !!(aiMessage.tool_calls && aiMessage.tool_calls.length > 0);

    // Assistant antwortet mit Tool-Calls?
    if (aiMessage.tool_calls) {
      context.messages.push({
        role: "assistant",
        tool_calls: aiMessage.tool_calls || null
      });

      // DEBUG: Welche Tools + Argumente?
      try {
        console.log(
          "DEBUG: ToolCalls received:",
          aiMessage.tool_calls.map((tc) => ({
            id: tc.id,
            name: tc.function?.name,
            args: tc.function?.arguments
          }))
        );
      } catch {
        /* ignore */
      }
    }

    // Freitext anhängen (falls vorhanden)
    if (aiMessage.content) {
      responseMessage += (aiMessage.content || "").trim();
    }

    // Tool-Calls ausführen (Registry bleibt unverändert)
    if (hasToolCalls) {
      for (const toolCall of aiMessage.tool_calls) {
        const fnName = toolCall?.function?.name;
        const fnArgs = toolCall?.function?.arguments;
        const toolFunction = toolRegistry[fnName];

        if (!toolFunction || !fnArgs) {
          console.error(`[ERROR] Tool '${fnName}' not found or arguments invalid.`);
          context.messages.push({
            role: "system",
            content: `[ERROR]: Tool '${fnName}' not found or arguments invalid.`
          });
          continue;
        }

        try {
          // DEBUG: Tool-Aufruf
          console.log("DEBUG: Execute Tool:", { tool: fnName, args: fnArgs });

          const toolResult = await toolFunction(toolCall.function, handoverContext, getAIResponse);
          lastmessage = toolResult;

          // DEBUG: Tool-Result (gekürzt)
          console.log(
            "DEBUG: Tool Result (first 400 chars):",
            typeof toolResult === "string" ? toolResult.slice(0, 400) : toolResult
          );

          context.messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: toolResult || "[ERROR]: Tool returned empty result."
          });
        } catch (toolError) {
          console.error(`[ERROR] Tool execution failed for '${fnName}':`, toolError);
          context.messages.push({
            role: "system",
            content: `[ERROR]: Tool execution failed: ${toolError.message}`
          });
        }
      }
    } else {
      if (lastmessage) {
        // alte Semantik beibehalten
        context_orig.add("assistant", "", lastmessage);
      }
    }

    // Fortsetzung, falls wegen length abgebrochen
    continueResponse = !hasToolCalls && finishReason === "length";
    if (continueResponse) {
      context.messages.push({ role: "user", content: "continue" });
    }

    sequenceCounter++;
    if (sequenceCounter >= sequenceLimit && !hasToolCalls && !continueResponse) {
      break;
    }
  } while (hasToolCalls || continueResponse);

  return responseMessage;
}

module.exports = { getAIResponse };

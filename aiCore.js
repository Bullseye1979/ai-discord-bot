// Version 2.0
// Provides the AI Functionality for the main process (tool_calls, length management, final answer)
// Änderungen:
// - Safe-Messages: 'name' wird vor API-Call entfernt; Sprecher optional als Tag im content.
// - max_tokens nur senden, wenn Zahl > 0; zusätzlich Fallback auf 4096 wenn null/undefined.
// - Tool-Calls korrekt durchreichen (assistant.tool_calls / tool.tool_call_id).

require('dotenv').config();
const axios = require('axios');
const { OPENAI_API_URL } = require('./config.js');
const Context = require('./context.js');

// ---- Helpers -------------------------------------------------------------

function sanitizeSpeakerTag(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_\-\.]/g, "")
    .slice(0, 64);
}

/**
 * Entfernt problematische Felder (name) und versieht Inhalte optional mit Sprecher-Tags.
 * - assistant mit tool_calls: nur tool_calls senden, keinen content
 * - tool: content + tool_call_id
 * - andere: content (+ optional Sprecher-Tag)
 */
function toSafeMessages(messages, { tagSpeakers = true } = {}) {
  return messages.map(m => {
    // assistant mit tool_calls -> spezieller Nachrichten-Typ
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      return { role: "assistant", tool_calls: m.tool_calls };
    }

    // tool-Nachricht
    if (m.role === "tool") {
      const out = { role: "tool", content: m.content ?? "" };
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      return out;
    }

    // normale Nachricht
    const out = { role: m.role, content: m.content ?? "" };

    // Sprecher als Tag in den Content heben (verhindert API-Fehler durch 'name', erhält Auswertbarkeit)
    if (tagSpeakers && m.name) {
      const tag = sanitizeSpeakerTag(m.name);
      out.content = `【speaker:${tag}】\n${out.content}`;
    }
    return out;
  });
}

// ---- Main ----------------------------------------------------------------

async function getAIResponse(
  context_orig,
  tokenlimit = 4096,
  sequenceLimit = 1000,
  model = "gpt-4-turbo",
  apiKey = null
) {
  // Robustes Handling: null/undefined -> 4096
  if (tokenlimit == null) tokenlimit = 4096;

  const context = new Context("", "", context_orig.tools, context_orig.toolRegistry);
  context.messages = [...context_orig.messages];

  const handoverContext = new Context("", "", context_orig.tools, context_orig.toolRegistry);
  handoverContext.messages = [...context_orig.messages];

  const toolRegistry = context.toolRegistry;

  // Zeit als System-Message injizieren (ohne name)
  const nowUtc = new Date().toISOString();
  context.messages.unshift({
    role: "system",
    content:
      "Current UTC time: " + nowUtc +
      " <- Use this time, whenever you are asked for the current time. Translate it to the location for which the time is requested. If no location is specified use your current location."
  });

  let responseMessage = "";
  let hasToolCalls = false;
  let continueResponse = false;
  let lastmessage = 0;
  let sequenceCounter = 0;

  const authKey = apiKey || process.env.OPENAI_API_KEY;

  do {
    // Sichere Messages für die API erzeugen
    const safeMessages = toSafeMessages(context.messages, { tagSpeakers: true });

    const payload = {
      model,
      messages: safeMessages,
      tool_choice: "auto"
    };

    // Tools nur anhängen, wenn vorhanden
    if (Array.isArray(context.tools) && context.tools.length > 0) {
      payload.tools = context.tools;
    }

    // max_tokens nur senden, wenn gültig
    if (typeof tokenlimit === "number" && Number.isFinite(tokenlimit) && tokenlimit > 0) {
      payload.max_tokens = tokenlimit;
    }

    let aiResponse;
    try {
      aiResponse = await axios.post(OPENAI_API_URL, payload, {
        headers: { Authorization: `Bearer ${authKey}` }
      });
    } catch (err) {
      console.error("[FATAL] Error from OpenAI:", err);
      if (err.response) {
        console.error(JSON.stringify(err.response.data, null, 2));
      }
      throw err;
    }

    const choice = aiResponse.data.choices[0];
    const aiMessage = choice.message;
    const finishReason = choice.finish_reason;

    hasToolCalls = aiMessage.tool_calls && aiMessage.tool_calls.length > 0;

    // Wichtig: Im lokalen Verlauf darf 'name' weiterhin existieren (aus context_orig),
    // aber an die API haben wir es NICHT gesendet.
    if (aiMessage.tool_calls) {
      // assistant Nachricht mit tool_calls in den Verlauf übernehmen
      context.messages.push({
        role: "assistant",
        tool_calls: aiMessage.tool_calls || null
      });
    }
    if (aiMessage.content) {
      responseMessage += aiMessage.content.trim();
    }

    if (hasToolCalls) {
      for (const toolCall of aiMessage.tool_calls) {
        const toolFunction = toolRegistry[toolCall.function.name];

        if (!toolFunction || !toolCall.function.arguments) {
          console.error(`[ERROR] Tool '${toolCall.function.name}' not found or arguments invalid.`);
          context.messages.push({
            role: "system",
            content: `[ERROR]: Tool '${toolCall.function.name}' not found or arguments invalid.`
          });
          continue;
        }

        try {
          const toolResult = await toolFunction(toolCall.function, handoverContext, getAIResponse);
          lastmessage = toolResult;

          // tool-Antwort in den Verlauf (mit tool_call_id)
          context.messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: toolResult || "[ERROR]: Tool returned empty result."
          });

        } catch (toolError) {
          console.error(`[ERROR] Tool execution failed for '${toolCall.function.name}':`, toolError);
          context.messages.push({
            role: "system",
            content: `[ERROR]: Tool execution failed: ${toolError.message}`
          });
        }
      }
    } else {
      // keine Tool-Calls; wenn letztes Tool etwas erzeugt hat, das in den Originalkontext soll:
      if (lastmessage) {
        // Beachte: context_orig.add(name) schreibt evtl. 'name' – intern ok.
        context_orig.add("assistant", "", lastmessage);
      }
    }

    continueResponse = !hasToolCalls && finishReason === "length";
    if (continueResponse) {
      // Fortsetzung anstoßen
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

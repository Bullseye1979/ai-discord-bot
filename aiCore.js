// Version 2.1
// Provides the AI Functionality for the main process (tool_calls, length management, final answer)
// Änderungen:
// - Sprecherinformationen bleiben im Context (name).
// - Nur für den API-Call werden Sprecher temporär als Tags in den content gehoben.
// - Nach dem API-Call werden Tags aus der Modell-Antwort entfernt, bevor wir sie zurückgeben oder in den Context schreiben.
// - 'name' wird nie an die API gesendet (vermeidet 500er).
// - max_tokens wird nur gesendet, wenn es eine Zahl > 0 ist; zusätzlich Fallback, falls Aufrufer null/undefined liefert.

require('dotenv').config();
const axios = require('axios');
const { OPENAI_API_URL } = require('./config.js');
const Context = require('./context.js');

// ------------------------------------------------------
// Helpers
// ------------------------------------------------------

function sanitizeSpeakerTag(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_\-\.]/g, "")
    .slice(0, 64);
}

// Tags nur temporär für den API-Call einbetten.
// WICHTIG: Wir taggen NUR USER-/SYSTEM-Nachrichten, NICHT assistant.
// So reduziert sich die Wahrscheinlichkeit, dass das Modell die Tags „nachahmt“.
function toSafeMessages(messages) {
  return messages.map(m => {
    // assistant mit tool_calls -> spezieller Nachrichtentyp (kein content + name)
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      return { role: "assistant", tool_calls: m.tool_calls };
    }

    // tool-Nachrichten: content + tool_call_id
    if (m.role === "tool") {
      const out = { role: "tool", content: m.content ?? "" };
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      return out;
    }

    // normale Nachrichten
    let content = m.content ?? "";

    // Nur USER und SYSTEM bekommen temporäre Sprecher-Tags (falls name vorhanden)
    if ((m.role === "user" || m.role === "system") && m.name) {
      const tag = sanitizeSpeakerTag(m.name);
      content = `【speaker:${tag}】\n${content}`;
    }

    // 'name' NIE mitsenden
    return { role: m.role, content };
  });
}

// Entfernt alle temporären Sprecher-Tags aus Text (für Anzeige + Kontextspeicherung)
function stripSpeakerMarkers(text) {
  if (!text) return text;
  return text.replace(/【speaker:[^】]+】\s*\n?/g, "").trim();
}

// ------------------------------------------------------
// Main
// ------------------------------------------------------

async function getAIResponse(
  context_orig,
  tokenlimit = 4096,
  sequenceLimit = 1000,
  model = "gpt-4-turbo",
  apiKey = null
) {
  // robust gegen null/undefined
  if (tokenlimit == null) tokenlimit = 4096;

  // Arbeitskontexte aufsetzen (ändern NICHT deinen Original-Kontext)
  const context = new Context("", "", context_orig.tools, context_orig.toolRegistry);
  context.messages = [...context_orig.messages];

  const handoverContext = new Context("", "", context_orig.tools, context_orig.toolRegistry);
  handoverContext.messages = [...context_orig.messages];

  const toolRegistry = context.toolRegistry;

  // Zeit als System-Message (ohne name)
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
    // Nur für den API-Call: Sprecher -> temporäre Tags in content (user/system)
    const safeMessages = toSafeMessages(context.messages);

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

    // Assistant-Toolcalls in unseren Arbeitskontext übernehmen
    if (aiMessage.tool_calls) {
      context.messages.push({
        role: "assistant",
        tool_calls: aiMessage.tool_calls || null
      });
    }

    // Die Antwort des Modells kann (selten) Tags „nachahmen“.
    // Wir entfernen ALLE Tags aus dem Rückkanal, BEVOR wir sie zurückgeben oder in den Original-Kontext schreiben.
    if (aiMessage.content) {
      const cleaned = stripSpeakerMarkers(aiMessage.content.trim());
      responseMessage += cleaned;
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

          // tool-Antworten in Arbeitskontext (werden beim nächsten Turn als tool gelesen)
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
      // keine Tool-Calls; evtl. Tool-Nachricht in den Originalkontext spiegeln
      if (lastmessage) {
        // In den ORIGINAL-Kontext OHNE Tags zurückschreiben
        const cleanedTool = stripSpeakerMarkers(String(lastmessage));
        context_orig.add("assistant", "", cleanedTool);
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

  // Rückgabe an Aufrufer: ebenfalls ohne Tags
  return stripSpeakerMarkers(responseMessage);
}

module.exports = { getAIResponse };

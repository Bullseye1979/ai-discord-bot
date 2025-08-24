// aiCore.js
const axios = require("axios");
const Context = require("./context.js");

// Kleine Helfer fürs API-Format
function safeName(name) {
  // OpenAI-Anforderung: ^[^\s<|\\/>]+$   -> keine Leerzeichen, keine Sonderzeichen <>|\/
  const pat = /^[^\s<|\\/>]+$/;
  if (typeof name !== "string" || !name.trim()) return undefined;  // lieber gar kein name als leer
  return pat.test(name) ? name : undefined;                        // ungültig -> weglassen
}
function toStringContent(x) {
  if (x == null) return "";
  if (typeof x === "string") return x;
  try { return JSON.stringify(x, null, 2); } catch { return String(x); }
}

// Alle Nachrichten so aufbereiten, dass sie garantiert API-kompatibel sind
function sanitizeForChatCompletions(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m || !m.role) continue;

    const role = m.role;
    const next = { role };

    // name nur, wenn erlaubt – und nie für assistant (ist optional/unnötig und oft fehlerträchtig)
    if (role !== "assistant" && m.name) {
      const sn = safeName(m.name);
      if (sn) next.name = sn;
    }

    // tool_calls-Fall (assistant mit Toolaufrufen braucht content = "")
    if (role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      next.content = ""; // WICHTIG: nie null/undefined
      next.tool_calls = m.tool_calls.map(tc => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.function?.name || "",
          arguments: typeof tc.function?.arguments === "string"
            ? tc.function.arguments
            : toStringContent(tc.function?.arguments ?? "{}"),
        }
      }));
      out.push(next);
      continue;
    }

    // tool-Nachricht: content MUSS String sein
    if (role === "tool") {
      next.tool_call_id = m.tool_call_id;
      if (m.name) {
        const sn = safeName(m.name);
        if (sn) next.name = sn;
      }
      next.content = toStringContent(m.content);
      out.push(next);
      continue;
    }

    // alle anderen Rollen: content als String, niemals null
    next.content = toStringContent(m.content);
    out.push(next);
  }
  return out;
}

/**
 * Holt eine Antwort von OpenAI inkl. Tool-Loop.
 * Fixes:
 *  - assistant mit tool_calls wird mit content:"" geloggt
 *  - nie null/fehlendes content
 *  - ungültige name-Felder werden entfernt
 *  - Tool-Result immer als String
 */
async function getAIResponse(
  context_orig,
  tokenlimit = 4096,
  sequenceLimit = 1000,
  model = "gpt-4-turbo",
  apiKey = null
) {
  if (tokenlimit == null) tokenlimit = 4096;
  const OPENAI_API_KEY = apiKey || process.env.OPENAI_API_KEY;

  // Arbeitskopien, damit wir History/Tools sauber halten
  const context = new Context("", "", context_orig.tools, context_orig.toolRegistry);
  context.messages = [...context_orig.messages];

  let responseMessage = "";
  let sequenceCounter = 0;

  // Tools (falls vorhanden) in OpenAI-Format bringen
  const tools =
    Array.isArray(context.tools)
      ? context.tools.map(t => ({
          type: "function",
          function: {
            name: t.function?.name,
            description: t.function?.description || "",
            parameters: t.function?.parameters || { type: "object", properties: {} },
          }
        }))
      : undefined;

  do {
    const messagesToSend = sanitizeForChatCompletions(context.messages);

    const requestBody = {
      model,
      messages: messagesToSend,
      max_tokens: tokenlimit,
    };
    if (tools && tools.length) {
      requestBody.tools = tools;
      requestBody.tool_choice = "auto";
    }

    let aiMessage = null;
    try {
      const { data } = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        requestBody,
        {
          headers: {
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 30000
        }
      );

      aiMessage = data?.choices?.[0]?.message || null;
      const finishReason = data?.choices?.[0]?.finish_reason || null;

      // Tool-Calls?
      if (aiMessage && Array.isArray(aiMessage.tool_calls) && aiMessage.tool_calls.length > 0) {
        // 1) Assistant mit tool_calls – **mit content:""** speichern
        context.messages.push({
          role: "assistant",
          content: "",                     // <— WICHTIG: niemals null/undefined
          tool_calls: aiMessage.tool_calls
        });

        // 2) Tool(s) ausführen und als tool-Nachrichten anhängen
        for (const tc of aiMessage.tool_calls) {
          const fnName = tc.function?.name;
          const argStr = tc.function?.arguments || "{}";
          let args;
          try { args = JSON.parse(argStr); } catch { args = { raw: argStr }; }

          let toolResult;
          try {
            // Dein Tool-Registry-Aufruf – passe das bei dir ggf. an:
            const impl = context.toolRegistry?.[fnName];
            if (!impl) {
              toolResult = { error: `Tool '${fnName}' not found.` };
            } else {
              toolResult = await impl(args);
            }
          } catch (e) {
            toolResult = { error: String(e?.message || e) };
          }

          context.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            name: fnName,
            content: toStringContent(toolResult),  // <— immer String
          });
        }

        // Loop fortsetzen, damit das Modell die Tool-Ergebnisse „liest“
        sequenceCounter++;
        if (sequenceCounter >= sequenceLimit) break;
        continue;
      }

      // Normale Assistenten-Antwort
      const content = toStringContent(aiMessage?.content || "");
      responseMessage += content;

      // In die laufende History mitschreiben
      context.messages.push({ role: "assistant", content });

      const reachedLength = (finishReason === "length");
      sequenceCounter++;
      if (sequenceCounter >= sequenceLimit || !reachedLength) {
        break; // fertig
      }

      // Falls abgeschnitten -> „continue“-Hint anhängen
      context.messages.push({ role: "user", content: "continue" });
      continue;

    } catch (err) {
      // Vollständiges Logging hilft bei Diagnose
      const detail = err?.response?.data || err?.message || err;
      console.error("[getAIResponse] OpenAI error:", detail);
      throw err;
    }

  } while (true);

  return responseMessage;
}

module.exports = {
  getAIResponse,
};

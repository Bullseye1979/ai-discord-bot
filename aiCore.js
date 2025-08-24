const axios = require("axios");

const NAME_OK = /^[^\s<|\\/>]+$/; // OpenAI pattern

function sanitizeName(n) {
  if (typeof n !== "string") return undefined;
  return NAME_OK.test(n) ? n : undefined;
}

// Drop-in replacement
async function getAIResponse(context_orig, max_tokens = 1024, model = "gpt-4o", apiKey) {
  const OPENAI_API_KEY = apiKey || process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  // Arbeitskopie, damit wir in der Schleife Messages anhängen können
  const context = JSON.parse(JSON.stringify(context_orig || {}));
  context.messages = Array.isArray(context.messages) ? context.messages : [];
  context.tools = Array.isArray(context.tools) ? context.tools : [];
  context.toolRegistry = context.toolRegistry || {};

  let sequenceLimit = 6;
  let sequenceCounter = 0;
  let responseMessage = "";

  do {
    // Immer: content garantiert String, name nur wenn Pattern passt
    const messagesToSend = context.messages.map((m) => {
      const out = {
        role: m.role,
        content: typeof m.content === "string" ? m.content : ""
      };
      const nm = sanitizeName(m.name);
      if (nm) out.name = nm;

      // Vorherige Tool-Schritte erhalten
      if (m.tool_calls) out.tool_calls = m.tool_calls;
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      if (m.name && m.role === "tool" && !out.name) out.name = m.name; // für Kompatibilität
      return out;
    });

    const data = {
      model,
      messages: messagesToSend,
      max_tokens,
      tool_choice: "auto",
      tools: context.tools
    };

    let res;
    try {
      res = await axios.post("https://api.openai.com/v1/chat/completions", data, {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`
        },
        timeout: 30000
      });
    } catch (e) {
      // Sauberer Fehlertext in den Verlauf und raus
      const msg = e?.response?.data?.error?.message || e?.message || "Unknown error";
      responseMessage = `⚠️ OpenAI error: ${msg}`;
      try { await context_orig.add("assistant", "", responseMessage); } catch {}
      return responseMessage;
    }

    const choice = res?.data?.choices?.[0];
    const aiMessage = choice?.message || {};
    const finishReason = choice?.finish_reason;

    const toolCalls = Array.isArray(aiMessage.tool_calls) ? aiMessage.tool_calls : [];
    const hasToolCalls = toolCalls.length > 0;

    // Case A: Es gibt Tool-Calls -> assistant (leer) + tool Results anfügen, dann nächste Schleifenrunde
    if (hasToolCalls) {
      // WICHTIG: content muss String sein, nicht null!
      context.messages.push({
        role: "assistant",
        content: "",
        tool_calls: toolCalls
      });

      // Jeden Tool-Call ausführen und als tool-Message (String!) anhängen
      for (const tc of toolCalls) {
        const fnName = tc?.function?.name;
        const argStr = tc?.function?.arguments || "{}";
        let parsedArgs = {};
        try { parsedArgs = JSON.parse(argStr); } catch { parsedArgs = {}; }

        let toolResult = "";
        try {
          const impl = context.toolRegistry[fnName];
          if (typeof impl === "function") {
            const res = await impl(parsedArgs);
            toolResult = typeof res === "string" ? res : JSON.stringify(res);
          } else {
            toolResult = JSON.stringify({ error: "tool_not_found", name: fnName || "" });
          }
        } catch (err) {
          toolResult = JSON.stringify({
            error: "tool_execution_failed",
            message: (err?.message || String(err)).slice(0, 2000)
          });
        }

        context.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: fnName || "tool",
          content: String(toolResult || "")
        });
      }

      // nach Tool-Ausführung nächste Runde, um die finale Antwort zu holen
      sequenceCounter++;
      if (sequenceCounter >= sequenceLimit) {
        responseMessage = "⚠️ Tool loop limit reached.";
        try { await context_orig.add("assistant", "", responseMessage); } catch {}
        return responseMessage;
      }
      continue; // nächste API-Runde
    }

    // Case B: Keine Tools -> normale Antwort
    const text = typeof aiMessage.content === "string" ? aiMessage.content : "";
    responseMessage = text;

    // In Verlauf speichern
    if (text) {
      try { await context_orig.add("assistant", "", text); } catch {}
    }

    // ggf. "continue" bei Length-Cutoff
    const continueResponse = finishReason === "length";
    if (continueResponse) {
      context.messages.push({ role: "user", content: "continue" });
      sequenceCounter++;
      if (sequenceCounter < sequenceLimit) {
        continue; // noch eine Runde zum Fortsetzen
      }
    }

    // Fertig
    break;
  } while (true);

  return responseMessage;
}

module.exports = { getAIResponse };

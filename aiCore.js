// Version 1.5
// Provides the AI Functionality for the main process (tool_calls, length management, final answer)
// - channelId wird wie früher in Context-Klone übernommen
// - Tool-Calls: (fn, handoverContext, getAIResponse, runtime) => rückwärtskompatibel, runtime nur optional

require('dotenv').config();
const axios = require('axios');
const { OPENAI_API_URL } = require('./config.js');
const Context = require('./context.js');

function sanitizeName(name) {
  if (!name) return undefined;
  // verbotene Zeichen/Whitespace -> "_", Mehrfach "_" verdichten, auf 64 kürzen
  let s = String(name).replace(/[\s<|\\/>]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (!s) return undefined;
  return s.slice(0, 64);
}

function sanitizeMessageForOpenAI(m) {
  const out = { role: m.role, content: m.content };

  // 'name' NUR setzen, wo es sicher ist (User/Tool) – und immer sanitizen.
  // Für 'system' und 'assistant' weglassen (reduziert Risiko und ist optional).
  if (m.role === "user" || m.role === "tool") {
    const nm = sanitizeName(m.name || m.sender);
    if (nm) out.name = nm;
  }
  return out;
}

async function getAIResponse(
  context_orig,
  tokenlimit = 4096,
  sequenceLimit = 1000,
  model = "gpt-4-turbo",
  apiKey = null,
) {
  if (tokenlimit == null) tokenlimit = 4096;

  // channelId aus dem Original übernehmen (für Tools)
  const channelId = context_orig?.channelId || "global";

  // Arbeits-Kontexte (separat, um History/Tools sauber zu halten)
  const context = new Context("", "", context_orig.tools, context_orig.toolRegistry, channelId);
  context.messages = [...context_orig.messages];

  const handoverContext = new Context("", "", context_orig.tools, context_orig.toolRegistry, channelId);
  handoverContext.messages = [...context_orig.messages];

  const toolRegistry = context.toolRegistry;

  // Zeitkontext
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
    const messagesToSend = context.messages.map(m => {
      const out = { role: m.role, content: m.content };
      if (m.name) out.name = m.name;
      if (m.tool_calls) out.tool_calls = m.tool_calls;
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      return out;
    });

    const safeMessages = (messagesToSend || []).map(sanitizeMessageForOpenAI);

    const payload = {
      model: model,
      messages: safeMessages,
      max_tokens: tokenlimit,
      tool_choice: "auto",
      tools: context.tools
    };

    let aiResponse;
    try {
      aiResponse = await axios.post(OPENAI_API_URL, payload, {
        headers: { Authorization: `Bearer ${authKey}` }
      });
    } catch (err) {
      console.error("[FATAL] Error from OpenAI:", err);
      if (err.response) console.error(JSON.stringify(err.response.data, null, 2));
      throw err;
    }

    const choice = aiResponse.data.choices[0];
    const aiMessage = choice.message;
    const finishReason = choice.finish_reason;

    hasToolCalls = aiMessage.tool_calls && aiMessage.tool_calls.length > 0;

    // Assistant mit Tool-Calls?
    if (aiMessage.tool_calls) {
      context.messages.push({
        role: "assistant",
        tool_calls: aiMessage.tool_calls || null
      });
    }
    // Freitext
    if (aiMessage.content) {
      responseMessage += aiMessage.content.trim();
    }

    // Tool-Calls ausführen
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
          // ✅ RÜCKWÄRTSKOMPATIBEL: 2. Param ist weiterhin der handoverContext
          //    channel_id wird NUR als optionales 4. Argument angehängt.
          const runtime = { channel_id: channelId };
          const toolResult = await toolFunction(toolCall.function, handoverContext, getAIResponse, runtime);
          lastmessage = toolResult;
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
      // Optional: letztes Toolresult separat im Original-Kontext ablegen
      if (lastmessage) {
        await context_orig.add("assistant", "", lastmessage);
      }
    }

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

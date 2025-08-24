// Version 1.4 (mit DEBUG-Logs)
// Provides the AI Functionality for the main process (tool_calls, length management, final answer)
// ✅ 'name' bleibt im Kontext; keine Speaker-Tags im Content
require('dotenv').config();
const axios = require('axios');
const { OPENAI_API_URL } = require('./config.js');
const Context = require('./context.js');

async function getAIResponse(
    context_orig,
    tokenlimit = 4096,
    sequenceLimit = 1000,
    model = "gpt-4-turbo",
    apiKey = null
) {
    if (tokenlimit == null) tokenlimit = 4096;

    // Arbeits-Kontexte (separat, um History/Tools sauber zu halten)
    const context = new Context("", "", context_orig.tools, context_orig.toolRegistry);
    context.messages = [...context_orig.messages];

    const handoverContext = new Context("", "", context_orig.tools, context_orig.toolRegistry);
    handoverContext.messages = [...context_orig.messages];

    const toolRegistry = context.toolRegistry;

    // Zeitkontext
    const nowUtc = new Date().toISOString();
    context.messages.unshift({
        role: "system",
        content: "Current UTC time: " + nowUtc + " <- Use this time, whenever you are asked for the current time. Translate it to the location for which the time is requested. If no location is specified use your current location."
    });

    let responseMessage = "";
    let hasToolCalls = false;
    let continueResponse = false;
    let lastmessage = 0;
    let sequenceCounter = 0;

    const authKey = apiKey || process.env.OPENAI_API_KEY;

    do {
        // Nachrichten an die API (nur gültige Felder)
        const messagesToSend = context.messages.map(m => {
            const out = { role: m.role, content: m.content };
            if (m.name) out.name = m.name;
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

        // 🔎 DEBUG: Was geht an die KI?
        try {
            console.log("──────────────── DEBUG:getAIResponse → OpenAI Payload ────────────────");
            console.log(JSON.stringify({
                model,
                max_tokens: tokenlimit,
                tools: (context.tools || []).map(t => t.function?.name),
                messages_preview: messagesToSend.map(m => ({
                    role: m.role,
                    name: m.name,
                    // nur die ersten 400 Zeichen zeigen, um Logs schlank zu halten
                    content: (m.content || "").slice(0, 400)
                }))
            }, null, 2));
            console.log("──────────────────────────────────────────────────────────────────────");
        } catch { /* ignore logging errors */ }

        let aiResponse;
        try {
            aiResponse = await axios.post(OPENAI_API_URL, payload, {
                headers: { Authorization: `Bearer ${authKey}` }
            });

            // 🔎 DEBUG: Kurzer Blick auf die Antwort-Metadaten
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
            console.error("[FATAL] Error from OpenAI:", err?.message || err);
            if (err.response) {
                console.error("OpenAI Error Response:", JSON.stringify(err.response.data, null, 2));
            }
            throw err;
        }

        const choice = aiResponse.data.choices[0];
        const aiMessage = choice.message;
        const finishReason = choice.finish_reason;

        hasToolCalls = aiMessage.tool_calls && aiMessage.tool_calls.length > 0;

        // Assistant antwortet mit Tool-Calls?
        if (aiMessage.tool_calls) {
            context.messages.push({
                role: "assistant",
                tool_calls: aiMessage.tool_calls || null
            });

            // 🔎 DEBUG: Welche Tools sollen gerufen werden?
            try {
                console.log("DEBUG: ToolCalls received:", aiMessage.tool_calls.map(tc => ({
                    id: tc.id,
                    name: tc.function?.name,
                    args: tc.function?.arguments
                })));
            } catch { /* ignore */ }
        }

        // Freitext-Antwort anhängen
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
                    // 🔎 DEBUG: Tool-Aufruf loggen
                    console.log("DEBUG: Execute Tool:", {
                        tool: toolCall.function.name,
                        args: toolCall.function.arguments
                    });

                    const toolResult = await toolFunction(toolCall.function, handoverContext, getAIResponse);
                    lastmessage = toolResult;

                    // 🔎 DEBUG: Tool-Result (gekürzt)
                    console.log("DEBUG: Tool Result (first 400 chars):",
                        typeof toolResult === "string" ? toolResult.slice(0, 400) : toolResult
                    );

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
            if (lastmessage) {
                context_orig.add("assistant", "", lastmessage);
            }
        }

        // Fortsetzungslogik, falls am Tokenlimit abgebrochen
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

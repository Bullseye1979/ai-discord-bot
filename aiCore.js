// Version 1.3
// Provides the AI Functionality for the main process (tool_calls, length management, final answer)
// ✅ Revert: 'name' bleibt im Kontext; keine Speaker-Tags im Content

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
    // Falls irgendwo null reinkommt, fangen wir das ab
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
        // 🔁 Nachrichten an die API: 'name' bleibt im Objekt, keine Speaker-Tags im Text
        const messagesToSend = context.messages.map(m => {
            // nur Felder weiterreichen, die die API kennt
            const out = { role: m.role, content: m.content };
            if (m.name) out.name = m.name;
            // Wenn vorherige Assistant-Message Tool-Calls enthält, kann das Modell darauf referenzieren
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

        // Assistant antwortet mit Tool-Calls?
        if (aiMessage.tool_calls) {
            context.messages.push({
                role: "assistant",
                tool_calls: aiMessage.tool_calls || null
            });
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
                    const toolResult = await toolFunction(toolCall.function, handoverContext, getAIResponse);
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
            // Wenn das letzte Resultat (z. B. Bild-URL) separat geloggt werden soll
            if (lastmessage) {
                context_orig.add("assistant", "", lastmessage);
            }
        }

        // Fortsetzungslogik, falls wir am Tokenlimit abgebrochen haben
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

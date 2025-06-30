// Version 1.0
// Provides the AI Functionality for the main process (tool_calls, length management, final answer)


// Requirements

require('dotenv').config();
const axios = require('axios');
const { OPENAI_API_URL } = require('./config.js');
const Context = require('./context.js');


// Functions

// takes the prefered AIModel and context and generates the AI response. It runs tool_calls and ensures that messages aren't cut off.

async function getAIResponse(context_orig, tokenlimit = 4096, sequenceLimit = 1000, model = "gpt-4-turbo") {
    const context = new Context("","",context_orig.tools, context_orig.toolRegistry);
    context.messages = [...context_orig.messages];
    const handoverContext = new Context("","",context_orig.tools, context_orig.toolRegistry);
    handoverContext.messages = [...context_orig.messages];
    const toolRegistry = context.toolRegistry;
    const nowUtc = new Date().toISOString();
    context.messages.unshift({ role: "system",content: "Current UTC time: "+nowUtc+" <- Use this time, whenever you are asked for the current time. Translate it to the location for which the time is requested. If no location is specified use your current location." });
    let responseMessage = "";
    let hasToolCalls = false;
    let continueResponse = false;
    let lastmessage=0;
    let sequenceCounter = 0;
    do {
        const payload = {
            model: model,
            messages: [...context.messages],
            max_tokens: tokenlimit,
            tool_choice: "auto",
            tools: context.tools
        };
        let aiResponse;
        try {
            aiResponse = await axios.post(OPENAI_API_URL, payload, {
                headers: {
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
                }
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
        if (aiMessage.tool_calls)
        {
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

                    console.log(toolCall.function.name);

                    const toolResult = await toolFunction(toolCall.function, handoverContext, getAIResponse);
                    lastmessage=toolResult;
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
        } else
        { 
            if (lastmessage)
            {
                context_orig.add("assistant","",lastmessage);
                console.log(lastmessage);
            }
        }
        continueResponse = !hasToolCalls && finishReason === "length";
        if (continueResponse) {
            context.messages.push({
                role: "user",
                content: "continue"
            });
        }
        sequenceCounter++;
        if (sequenceCounter >= sequenceLimit && !hasToolCalls && !continueResponse) {
            break;
        }

    } while (hasToolCalls || continueResponse);
    return responseMessage;
}


// Exports

module.exports = { getAIResponse };
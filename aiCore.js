// aiCore.js — refactored v2.0 (getHistory first-try fix: inject :channel_id, ORDER BY, LIMIT)
// Chat loop with tool-calls, safe logging, strict auto-continue guard.

require("dotenv").config();
const axios = require("axios");
const { OPENAI_API_URL } = require("./config.js");
const Context = require("./context.js");
const { reportError } = require("./error.js");

/** Sanitize 'name' per OpenAI schema; omit for system/tool roles */
function cleanOpenAIName(role, name) {
  if (!name) return undefined;
  if (role === "system" || role === "tool") return undefined;

  let s = String(name)
    .trim()
    .replace(/[\s<|\\/>\u0000-\u001F]/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  s = s.slice(0, 64);
  if (!s) return undefined;

  const reserved = new Set(["assistant", "user", "system", "tool"]);
  if (reserved.has(s.toLowerCase())) return undefined;
  return s;
}

/** Best-effort fixups for getHistory tool calls (so the first attempt works). */
function fixupGetHistoryArgs(toolFn) {
  try {
    const argsObj =
      typeof toolFn.arguments === "string"
        ? JSON.parse(toolFn.arguments || "{}")
        : (toolFn.arguments || {});
    let sql = String(argsObj.sql || "").trim();
    if (!sql) return toolFn; // nothing to do

    // Ensure :channel_id is present in the WHERE
    if (!/:channel_id\b/i.test(sql)) {
      if (/\bwhere\b/i.test(sql)) {
        // has WHERE -> append AND
        sql = sql.replace(/\s*;+\s*$/g, "");
        sql += " AND channel_id = :channel_id";
      } else {
        // no WHERE -> add one
        sql = sql.replace(/\s*;+\s*$/g, "");
        sql += " WHERE channel_id = :channel_id";
      }
    }

    // Ensure ORDER BY timestamp (if none exists)
    if (!/\border\s+by\b/i.test(sql)) {
      sql += " ORDER BY timestamp ASC";
    }

    // Ensure LIMIT (tool also adds a default, but we enforce here so the LLM's first try passes)
    if (!/\blimit\s+\d+/i.test(sql)) {
      sql += " LIMIT 200";
    }

    argsObj.sql = sql;
    // Make sure we keep bindings object around (tool will fill channel_id value itself)
    if (!argsObj.bindings || typeof argsObj.bindings !== "object") {
      argsObj.bindings = {};
    }

    return { ...toolFn, arguments: JSON.stringify(argsObj) };
  } catch {
    return toolFn; // don't break if parsing fails
  }
}

/**
 * Run a chat loop with tool-calls and bounded auto-continue.
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
  let responseMessage = "";
  try {
    if (tokenlimit == null) tokenlimit = 4096;

    // Arbeitskopien des Kontexts (Antwort-Kontext + Handover für Tools)
    // WICHTIG: channelId mitgeben, damit Tools (getHistory) die :channel_id erkennen
    const context = new Context(
      "",
      "",
      context_orig.tools,
      context_orig.toolRegistry,
      context_orig.channelId || null,
      { skipInitialSummaries: true, persistToDB: false }
    );
    context.messages = [...context_orig.messages];

    const handoverContext = new Context(
      "",
      "",
      context_orig.tools,
      context_orig.toolRegistry,
      context_orig.channelId || null,
      { skipInitialSummaries: true, persistToDB: false }
    );
    handoverContext.messages = [...context_orig.messages];

    const toolRegistry = context.toolRegistry;

    // Systemzusammensetzung
    try {
      const sysParts = [];
      if ((context_orig.persona || "").trim()) sysParts.push(String(context_orig.persona).trim());
      if ((context_orig.instructions || "").trim()) sysParts.push(String(context_orig.instructions).trim());
      const sysCombined = sysParts.join("\n\n").trim();
      if (sysCombined) {
        context.messages.unshift({ role: "system", content: sysCombined });
      }
    } catch {}

    // Zeit-Hinweis
    const nowUtc = new Date().toISOString();
    context.messages.unshift({
      role: "system",
      content: `Current UTC time: ${nowUtc} <- Use this time whenever asked. Translate to the requested location; if none, use your current location.`
    });

    let hasToolCalls = false;
    let continueResponse = false;
    let sequenceCounter = 0;

    const authKey = apiKey || process.env.OPENAI_API_KEY;

    do {
      // Nachrichten für API aufbereiten
      const messagesToSend = context.messages.map((m) => {
        const out = { role: m.role, content: m.content };
        const safeName = cleanOpenAIName(m.role, m.name);
        if (safeName) out.name = safeName;
        if (m.tool_calls) out.tool_calls = m.tool_calls;
        if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
        return out;
      });

      const payload = {
        model,
        messages: messagesToSend,
        max_tokens: tokenlimit,
        tool_choice: "auto",
        tools: context.tools,
      };

      // API Call
      let aiResponse;
      try {
        aiResponse = await axios.post(OPENAI_API_URL, payload, {
          headers: { Authorization: `Bearer ${authKey}`, "Content-Type": "application/json" },
        });
      } catch (err) {
        await reportError(err, null, "OPENAI_CHAT");
        throw err;
      }

      const choice = aiResponse.data.choices[0];
      const aiMessage = choice.message;
      const finishReason = choice.finish_reason;

      hasToolCalls = !!(aiMessage.tool_calls && aiMessage.tool_calls.length > 0);

      if (aiMessage.tool_calls) {
        context.messages.push({
          role: "assistant",
          tool_calls: aiMessage.tool_calls || null,
        });
      }

      if (aiMessage.content) {
        responseMessage += (aiMessage.content || "").trim();
      }

      // Tool-Ausführung
      if (hasToolCalls) {
        for (const toolCall of aiMessage.tool_calls) {
          const fnName = toolCall?.function?.name;
          const toolFunction = toolRegistry ? toolRegistry[fnName] : undefined;

          const replyTool = (content) => {
            const out =
              typeof content === "string" || content == null
                ? content || ""
                : (() => { try { return JSON.stringify(content); } catch { return String(content); } })();

            context.messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: out,
            });
          };

          if (!toolFunction) {
            const msg = `[ERROR]: Tool '${fnName}' not available or arguments invalid.`;
            replyTool(msg);
            continue;
          }

          try {
            // *** RUNTIME mit channel_id an das Tool geben ***
            const runtime = { channel_id: context_orig.channelId || handoverContext.channelId || null };

            // *** getHistory First-Try Fix: fehlende :channel_id / ORDER BY / LIMIT automatisch ergänzen
            let toolFnToCall = toolCall.function;
            if (fnName === "getHistory") {
              toolFnToCall = fixupGetHistoryArgs(toolFnToCall);
            } else {
              // defensive: sorge dafür, dass arguments mindestens "{}" ist
              if (toolFnToCall && typeof toolFnToCall.arguments === "undefined") {
                toolFnToCall = { ...toolFnToCall, arguments: "{}" };
              }
            }

            const toolResult = await toolFunction(toolFnToCall, handoverContext, getAIResponse, runtime);
            replyTool(toolResult || "");
          } catch (toolError) {
            const emsg = toolError?.message || String(toolError);
            await reportError(toolError, null, `TOOL_${fnName?.toUpperCase?.() || "UNKNOWN"}`);
            replyTool({ error: emsg, tool: fnName || "unknown" });
          }
        }
      }

      sequenceCounter++;

      const dueToLength = !hasToolCalls && finishReason === "length";

      if (sequenceLimit <= 1) {
        continueResponse = false;
      } else if (dueToLength) {
        if (sequenceCounter < sequenceLimit) {
          if ((aiMessage.content || "").trim()) {
            context.messages.push({ role: "assistant", content: (aiMessage.content || "").trim() });
          }
          context.messages.push({ role: "user", content: "continue" });
          continueResponse = true;
        } else {
          continueResponse = false;
        }
      } else {
        continueResponse = false;
      }
    } while (hasToolCalls || continueResponse);

    return responseMessage;
  } catch (err) {
    await reportError(err, null, "GET_AI_RESPONSE");
    throw err;
  }
}

module.exports = { getAIResponse };

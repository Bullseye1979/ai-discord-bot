// aiCore.js — full file
// - liefert getAIResponse(chatContext, _, _, modelOverride, apiKeyOverride)
// - respektiert chatContext.tools & chatContext.toolRegistry (per bot.js gesetzt)
// - Tool-Schleife mit sauberem assistant.content=="" bei tool_calls
// - keine Format-Änderung an euren Tool-Definitionen im Request

require("dotenv").config();
const axios = require("axios");

// Fallbacks / Defaults
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4-turbo";

// Hilfsfunktion: content immer zu einem String machen (nie null/undefined)
function normalizeMessageContent(msg) {
  if (msg && msg.role && typeof msg.content !== "string") {
    // leeren String einsetzen (wichtig bei tool_calls)
    msg.content = "";
  }
  return msg;
}

// Hilfsfunktion: sicheres, flaches Deep-Copy der Messages
function cloneMessages(arr) {
  return (arr || []).map(m => {
    const copy = { ...m };
    // tiefe Kopie für evtl. nested Felder (selten genutzt)
    if (copy.function_call) copy.function_call = { ...copy.function_call };
    if (copy.tool_calls) copy.tool_calls = copy.tool_calls.map(tc => ({
      id: tc.id, type: tc.type,
      function: tc.function ? { ...tc.function } : undefined
    }));
    return copy;
  });
}

// System-Zeit als separate System-Nachricht (wie bisher im Log gesehen)
function buildTimeSystemMessage() {
  const now = new Date().toISOString();
  return {
    role: "system",
    content: `${"Current UTC time: "}${now} <- Use this time, whenever you are asked for the current time. Translate it to the location for which the time is requested. If no location is specified use your current location.`
  };
}

// Tools aus dem Chat-Kontext holen; falls nicht vorhanden, leer
function getToolsFromContext(chatContext) {
  // chatContext.tools wird in discord-handler gesetzt (Channel-/User-spezifisch)
  return Array.isArray(chatContext?.tools) ? chatContext.tools : [];
}

// Tool-Registry aus dem Chat-Kontext holen; falls nicht vorhanden, leer
function getRegistryFromContext(chatContext) {
  const reg = chatContext?.toolRegistry || {};
  return reg && typeof reg === "object" ? reg : {};
}

// Eine Runde Chat Completion abschicken
async function callOpenAI(apiKey, model, messages, tools) {
  // defensive: content normalisieren (insb. assistant mit tool_calls == "")
  const safeMessages = messages.map(normalizeMessageContent);

  const body = {
    model: model || DEFAULT_MODEL,
    messages: safeMessages,
    max_tokens: 4096,
    tool_choice: "auto"
  };

  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools; // unverändert wie von euch definiert
  }

  const res = await axios.post(OPENAI_API_URL, body, {
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    // kein globales Timeout hier; euer Runtime/PM2 steuert das
  });

  const choice = res?.data?.choices?.[0];
  const msg = choice?.message || {};
  return {
    message: msg,
    raw: res.data
  };
}

// Tool-Call ausführen und Tool-Message erzeugen
async function executeToolCall(toolCall, registry, userIdForTools) {
  // toolCall: { id, type: "function", function: { name, arguments } }
  const name = toolCall?.function?.name;
  const argsRaw = toolCall?.function?.arguments || "{}";

  let args;
  try {
    args = JSON.parse(argsRaw);
  } catch {
    args = {};
  }

  // Manche Tools erwarten user_id – falls nicht übergeben, ergänzen wir ihn
  if (userIdForTools && typeof args === "object" && args && !("user_id" in args)) {
    args.user_id = userIdForTools;
  }

  const exec = registry[name];
  let out = "";
  try {
    if (typeof exec === "function") {
      const result = await exec(args);
      if (typeof result === "string") out = result;
      else out = JSON.stringify(result ?? {});
    } else {
      out = JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (e) {
    out = JSON.stringify({ error: `Tool ${name} failed: ${e?.message || String(e)}` });
  }

  // Tool-Antwort-Nachricht (mit tool_call_id, wie die API es erwartet)
  return {
    role: "tool",
    tool_call_id: toolCall.id,
    content: out,
    name // schadet nicht und hilft beim Debuggen
  };
}

/**
 * Haupteinstieg: erzeugt Text-Antwort (ohne Webhook/ohne TTS – das machen andere Teile)
 * @param {Context} chatContext – enthält messages, tools, toolRegistry usw.
 * @param {*} _unusedA – bleibt aus Kompatibilitätsgründen erhalten
 * @param {*} _unusedB – bleibt aus Kompatibilitätsgründen erhalten
 * @param {string} modelOverride – optionales Modell
 * @param {string} apiKeyOverride – optionaler API Key
 * @returns {Promise<string>} – finaler Assistant-Text
 */
async function getAIResponse(chatContext, _unusedA = null, _unusedB = null, modelOverride = null, apiKeyOverride = null) {
  const apiKey = (apiKeyOverride || process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  // 1) Ausgangs-Messages aus dem Kontext kopieren
  const base = cloneMessages(chatContext?.messages || []);

  // 2) Zeit-System-Message vornedran (wie bisher in euren Requests)
  const messages = [buildTimeSystemMessage(), ...base];

  // 3) Tools & Registry aus dem Kontext
  const tools = getToolsFromContext(chatContext);
  const registry = getRegistryFromContext(chatContext);

  // 4) Tool-Loop: maximal 5 Runden
  let finalText = "";
  let rounds = 0;

  while (rounds < 5) {
    rounds++;

    // Eine Runde zum Modell
    let result;
    try {
      result = await callOpenAI(apiKey, modelOverride || DEFAULT_MODEL, messages, tools);
    } catch (err) {
      // Diagnostik konsolidiert
      const data = err?.response?.data;
      if (data?.error) {
        console.error(JSON.stringify(data, null, 2));
      }
      throw err;
    }

    const assistant = result.message || {};
    const toolCalls = assistant.tool_calls || [];

    if (toolCalls.length > 0) {
      // Assistant-Message mit tool_calls muss content=="" sein
      messages.push(normalizeMessageContent({
        role: "assistant",
        content: assistant.content, // wird unten zu "" korrigiert
        tool_calls: toolCalls
      }));

      // Tool-Calls ausführen + als "tool"-Messages anhängen
      for (const tc of toolCalls) {
        const toolMsg = await executeToolCall(tc, registry, chatContext?.userId || undefined);
        messages.push(toolMsg);
      }

      // nächste Runde
      continue;
    }

    // Keine Tool-Calls: finale Text-Antwort
    const text = (assistant.content || "").trim();
    finalText = text;
    break;
  }

  return finalText;
}

module.exports = {
  getAIResponse
};

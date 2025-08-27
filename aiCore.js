// aiCore.js — v1.7
// Chat-Loop mit Tool-Calls (robust), Auto-Continue, DEBUG-Logs
require("dotenv").config();
const axios = require("axios");
const { OPENAI_API_URL } = require("./config.js");

/**
 * Name-Sanitizing gemäß OpenAI (^ [^\\s<|\\/>]+ $); löscht KEINE Messages, fasst nur name an
 */
function cleanOpenAIName(role, name) {
  if (!name) return undefined;
  // Für system/tool kein Name senden
  if (role === "system" || role === "tool") return undefined;

  let s = String(name)
    .trim()
    .replace(/[\s<|\\/>\u0000-\u001F]/g, "_") // Whitespace/Steuerz./<|\ />
    .replace(/[^A-Za-z0-9._-]/g, "_")          // Whitelist
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  s = s.slice(0, 64);
  if (!s) return undefined;

  const reserved = new Set(["assistant", "user", "system", "tool"]);
  if (reserved.has(s.toLowerCase())) return undefined;

  return s;
}

/** Sichere Axios-Fehlerausgabe (keine Tokens leaken) */
function logAxiosErrorSafe(prefix, err) {
  const msg = err?.message || String(err);
  console.error(prefix, msg);
  if (err?.response) {
    try {
      const safeHeaders = { ...err.response.headers };
      if (safeHeaders.authorization) safeHeaders.authorization = "Bearer ***";
      const cfg = err.response.config || {};
      const safeCfg = {
        method: cfg.method,
        url: cfg.url,
        headers: cfg.headers ? { ...cfg.headers, Authorization: "Bearer ***" } : undefined,
        data: undefined
      };
      console.error(`${prefix} Response:`, {
        status: err.response.status,
        statusText: err.response.statusText,
        headers: safeHeaders,
        data: err.response.data,
        config: safeCfg
      });
    } catch (e) {
      console.error(`${prefix} (while masking)`, e);
    }
  }
}

/**
 * Versuche, die Chat-Nachrichten aus dem Context in OpenAI-Form zu bekommen.
 * Wir probieren mehrere übliche Methodennamen, damit es "drop-in" zu deiner Context-Klasse passt.
 */
async function extractMessagesFromContext(ctx) {
  const tryFns = [
    "getOpenAIMessages",
    "getContextForOpenAI",
    "getMessagesForOpenAI",
    "getMessages",
    "getContext",
  ];
  for (const fn of tryFns) {
    if (typeof ctx?.[fn] === "function") {
      const m = await ctx[fn]();
      if (Array.isArray(m)) return m;
    }
  }
  // Fallback: baue nur System aus persona/instructions
  const sys = [];
  const persona = (ctx?.persona || "").trim();
  const instr = (ctx?.instructions || "").trim();
  const sysText = [persona, instr].filter(Boolean).join("\n\n").trim();
  if (sysText) sys.push({ role: "system", content: sysText });
  return sys;
}

/**
 * Tools aus dem Context holen → OpenAI-Tools und Registry (Name → JS-Funktion)
 */
function extractToolsFromContext(ctx) {
  const tools = Array.isArray(ctx?.tools) ? ctx.tools : [];
  const registry = ctx?.toolRegistry && typeof ctx.toolRegistry === "object"
    ? ctx.toolRegistry
    : {};
  // Nur Tools im OpenAI-Format durchreichen
  const openAITools = tools
    .filter(t => t && typeof (t.function?.name || t.name) === "string")
    .map(t => ({
      type: "function",
      function: {
        name: t.function?.name || t.name,
        description: t.function?.description || t.description || "",
        parameters: t.function?.parameters || t.parameters || { type: "object", properties: {} },
      }
    }));
  return { tools: openAITools, registry };
}

/**
 * Einen einzelnen OpenAI-Call ausführen.
 */
async function callOpenAIChat({
  apiKey,
  model,
  messages,
  tools,           // optional
  maxTokens,       // optional (Ausgabe-Limit)
  temperature = 0.7
}) {
  const url = OPENAI_API_URL || "https://api.openai.com/v1/chat/completions";
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey || process.env.OPENAI_API_KEY}`,
  };
  const body = {
    model: model || "gpt-4o",
    messages,
    temperature,
  };

  // Nur setzen, wenn sinnvoller Wert
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    body.max_tokens = Math.floor(maxTokens);
  }
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  try {
    const res = await axios.post(url, body, { headers, timeout: 120000 });
    return res.data;
  } catch (err) {
    logAxiosErrorSafe("[OpenAI ERROR]", err);
    throw err;
  }
}

/**
 * Tool-Calls (function calling) aus der Assistant-Antwort abarbeiten.
 * Gibt die "Tool"-Nachrichten (role:"tool") zurück, die anschließend an das Chat-Protokoll gehängt werden.
 */
async function runToolCalls(toolCalls, registry) {
  const toolMsgs = [];
  if (!Array.isArray(toolCalls) || !toolCalls.length) return toolMsgs;

  for (const call of toolCalls) {
    const id = call.id;
    const fnName = call.function?.name;
    const argStr = call.function?.arguments || "{}";

    let parsedArgs;
    try {
      parsedArgs = argStr ? JSON.parse(argStr) : {};
    } catch {
      parsedArgs = {};
    }

    let resultStr = "";
    try {
      const impl = registry?.[fnName];
      if (!impl) {
        resultStr = JSON.stringify({ error: `Tool "${fnName}" not found in registry.` });
      } else {
        const maybe = await impl(parsedArgs);
        if (typeof maybe === "string") {
          resultStr = maybe;
        } else {
          resultStr = JSON.stringify(maybe ?? null);
        }
      }
    } catch (e) {
      resultStr = JSON.stringify({ error: String(e?.message || e) });
    }

    toolMsgs.push({
      role: "tool",
      tool_call_id: id,
      name: fnName,
      content: resultStr,
    });
  }
  return toolMsgs;
}

/**
 * Hauptloop
 * @param {object} context_orig   – deine Context-Instanz
 * @param {number|null} tokenlimit – max Tokens pro einzelnen OpenAI-Call (Ausgabe)
 * @param {number} sequenceLimit   – max Anzahl Folge-Calls (Auto-Continue / Tool-Schritte)
 * @param {string} model
 * @param {string|null} apiKey
 * @returns {Promise<string>} – finaler Assistant-Text
 */
async function getAIResponse(context_orig, tokenlimit = null, sequenceLimit = 1000, model = "gpt-4o", apiKey = null) {
  // 1) Nachrichten + Tools aus Context holen
  let messages = await extractMessagesFromContext(context_orig);
  const { tools, registry } = extractToolsFromContext(context_orig);

  // 2) Namen sanitisieren
  messages = messages.map(m => {
    const role = m.role || "user";
    const name = cleanOpenAIName(role, m.name);
    const content = m.content;
    const out = { role, content };
    if (name) out.name = name;
    // tool-Nachrichten können 'tool_call_id' haben – hier aber irrelevant (kommen später aus runToolCalls)
    return out;
  });

  // 3) Loop mit Tool-Calls + optional Auto-Continue
  let finalText = "";
  const maxSteps = Math.max(1, Math.min(1000, Number(sequenceLimit) || 1)); // harte Klammer
  for (let step = 0; step < maxSteps; step++) {
    // EIN Call
    const data = await callOpenAIChat({
      apiKey,
      model,
      messages,
      tools,
      maxTokens: tokenlimit,
      temperature: 0.6
    });

    const choice = data?.choices?.[0];
    if (!choice) {
      // kein Ergebnis → abbrechen
      break;
    }

    const msg = choice.message || {};
    const finish = choice.finish_reason || ""; // "stop" | "length" | "tool_calls" | "content_filter" | ...

    // Tool-Calls?
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      // 3a) Assistant-Message mit Tool-Calls in den Verlauf hängen
      const assistantMsg = {
        role: "assistant",
        content: msg.content || null, // meist leer, aber wir hängen es sicherheitshalber an
      };
      if (msg.name) assistantMsg.name = cleanOpenAIName("assistant", msg.name);
      if (msg.tool_calls) assistantMsg.tool_calls = msg.tool_calls;
      messages.push(assistantMsg);

      // 3b) Tools ausführen → Tool-Nachrichten anhängen
      const toolMsgs = await runToolCalls(msg.tool_calls, registry);
      messages.push(...toolMsgs);
      // nächster Loop-Durchlauf (Sequence fortsetzen)
      continue;
    }

    // Normale Assistant-Antwort
    const text = (msg.content || "").trim();
    finalText += (finalText ? "\n" : "") + text;

    // Wenn OpenAI wegen Länge abgebrochen hat und wir noch "dürfen": Auto-Continue
    if (finish === "length" && step + 1 < maxSteps) {
      // An den Verlauf hängen wir die (abgeschnittene) Assistant-Antwort + einen knappen „continue“-Prompt
      const assistantMsg = { role: "assistant", content: text };
      if (msg.name) assistantMsg.name = cleanOpenAIName("assistant", msg.name);
      messages.push(assistantMsg);

      messages.push({ role: "user", content: "continue" });
      // und weiter …
      continue;
    }

    // Sonst: fertig
    break;
  }

  return (finalText || "").trim();
}

module.exports = { getAIResponse };

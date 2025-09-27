// aiCore.js — v3.1-compat (Unified Tool Loop + getAIResponse Shim)
// ---------------------------------------------------------------
// - Ein einziger Loop: Modell → (tool_calls?) → Tools → Modell … bis fertig.
// - Kein separater Finalizer-Flow nötig.
// - Große Tool-Outputs werden als mehrere tool-Nachrichten gechunked.
// - Backward-Compat: exportiert zusätzlich getAIResponse(...), das wie v2.46 einen *String* liefert.
//
// Erwartete Umgebung (kompatibel zu deiner v2.46):
// - context_orig: { messages, tools, toolRegistry, channelId?, persona?, instructions? }
// - Tools im alten Format: fn({ name, arguments }, handoverContext, getAIResponse, runtime)
// - OPENAI_API_URL / OPENAI_API_KEY via config/env möglich
//
// Hinweis: Der Shim injiziert optional Standardpriming/Persona/Instructions und UTC-Zeit
//          (wie in deiner v2.46), falls vorhanden.

require("dotenv").config();
const axios = require("axios");
const http = require("http");
const https = require("https");
const { OPENAI_API_URL } = require("./config.js");

/* -------------------- Transport (wie gehabt) -------------------- */
const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 16, timeout: 30_000 });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 16, timeout: 30_000 });
const axiosAI = axios.create({
  httpAgent: keepAliveHttpAgent,
  httpsAgent: keepAliveHttpsAgent,
  timeout: 180_000,
  maxRedirects: 0,
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
});
async function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function deepClone(obj){ try { return JSON.parse(JSON.stringify(obj)); } catch { return obj; } }

async function postWithRetry(url, payload, headers, tries = 3) {
  let lastErr;
  const stable = deepClone(payload);
  for (let i = 0; i < tries; i++) {
    try {
      const res = await axiosAI.post(url, stable, { headers, validateStatus: () => true });
      if (res.status >= 200 && res.status < 300) return res;
      const transient = res.status >= 500 || res.status === 429;
      if (!transient) { const e = new Error(`AI_HTTP_${res.status}`); e.response = res; throw e; }
      lastErr = new Error(`AI_HTTP_${res.status}`);
    } catch (err) {
      lastErr = err;
      const maybeTransient = ["ECONNRESET","EPIPE","ETIMEDOUT"].includes(err?.code) ||
                             /socket hang up|ERR_STREAM_PREMATURE_CLOSE/.test(String(err?.message||""));
      if (!maybeTransient && !String(err?.message||"").startsWith("AI_HTTP_") && i === tries - 1) throw err;
    }
    await sleep(300 * Math.pow(2, i));
  }
  throw lastErr;
}

function normalizeEndpoint(raw) {
  const fallback = "https://api.openai.com/v1/chat/completions";
  let url = (raw || "").trim();
  if (!url) return fallback;
  if (/\/v1\/chat\/completions\/?$/.test(url)) return url.replace(/\/+$/, "");
  if (/\/v1\/?$/.test(url)) return url.replace(/\/v1\/?$/, "/v1/chat/completions");
  if (/\/v1\/responses\/?$/.test(url)) return url.replace(/\/v1\/responses\/?$/, "/v1/chat/completions");
  return url.replace(/\/+$/, "");
}

/* -------------------- Unified Loop Kern -------------------- */
const DEFAULTS = {
  maxToolLoops: 8,
  maxContinues: 2,
  toolChunkSize: 12000,     // ~Zeichen
  enableTools: true,
  continueOnLength: true,
};

function chunkString(str, size) {
  if (!str || typeof str !== "string" || size <= 0) return [String(str ?? "")];
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out;
}

async function runSingleToolCall(toolCall, toolsRegistry, ctx) {
  const { id, function: fn } = toolCall || {};
  const toolName = fn?.name;
  const rawArgs = fn?.arguments ?? "{}";

  if (!toolsRegistry?.has(toolName)) {
    return { id, name: toolName, ok: false, error: `Unknown tool: ${toolName}`, output: `{"error":"Unknown tool: ${toolName}"}` };
  }

  let parsed;
  try { parsed = rawArgs ? JSON.parse(rawArgs) : {}; }
  catch (e) { return { id, name: toolName, ok:false, error:`Invalid JSON arguments for ${toolName}: ${e.message}`, output:`{"error":"Invalid arguments"}` }; }

  try {
    const toolFn = toolsRegistry.get(toolName);
    const result = await toolFn(parsed, ctx);
    const output = (typeof result === "string") ? result : JSON.stringify(result ?? {});
    return { id, name: toolName, ok: true, output };
  } catch (e) {
    return { id, name: toolName, ok:false, error: e?.message || String(e), output: JSON.stringify({ error: e?.message || String(e) }) };
  }
}

async function executeAllToolCalls(lastAssistant, toolsRegistry, ctx, toolChunkSize) {
  const toolCalls = lastAssistant?.tool_calls || [];
  const toolMessages = [];
  const execResults = [];

  for (const tc of toolCalls) {
    const res = await runSingleToolCall(tc, toolsRegistry, ctx);
    execResults.push(res);
    const chunks = chunkString(res.output ?? "", toolChunkSize);
    for (const part of chunks) {
      toolMessages.push({ role: "tool", tool_call_id: tc.id, name: res.name || tc.function?.name, content: part });
    }
  }
  return { toolMessages, execResults };
}

async function askModel(openai, { model, messages, tools, tool_choice, temperature, max_tokens, stop }) {
  return openai.chat.completions.create({
    model,
    messages,
    ...(tools ? { tools } : {}),
    ...(tool_choice ? { tool_choice } : {}),
    ...(temperature != null ? { temperature } : {}),
    ...(max_tokens != null ? { max_tokens } : {}),
    ...(stop ? { stop } : {}),
  });
}

async function runUnifiedFlow(deps, opts) {
  const { openai, toolsRegistry, replyFormat } = deps;
  const {
    model,
    messages: initialMessages,
    tools,
    enableTools = DEFAULTS.enableTools,
    maxToolLoops = DEFAULTS.maxToolLoops,
    maxContinues = DEFAULTS.maxContinues,
    toolChunkSize = DEFAULTS.toolChunkSize,
    temperature,
    max_tokens,
    stop,
    ctx = {},
    // Kompat-Optionen:
    tokenlimit,
    continueOnLength = DEFAULTS.continueOnLength,
  } = opts || {};

  const effMaxTokens = (max_tokens == null && tokenlimit != null) ? tokenlimit : max_tokens;
  const trace = [];
  const messages = Array.isArray(initialMessages) ? [...initialMessages] : [];

  let loops = 0;
  let continues = 0;
  let lastResponse = null;

  while (true) {
    loops++;
    if (loops > Math.max(1, maxToolLoops)) { trace.push({ type: "guard", note: "maxToolLoops reached" }); break; }

    const tool_choice = enableTools ? undefined : "none";

    const resp = await askModel(openai, {
      model, messages, tools: enableTools ? tools : undefined, tool_choice,
      temperature, max_tokens: effMaxTokens, stop,
    });

    lastResponse = resp;
    const choice = resp?.choices?.[0] || {};
    const msg = choice.message || {};
    const finish = choice.finish_reason;
    const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;

    trace.push({ type: "model", finish, hasToolCalls, usage: resp?.usage });

    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls ?? undefined });

    if (hasToolCalls) {
      const { toolMessages, execResults } = await executeAllToolCalls(msg, toolsRegistry, ctx, toolChunkSize);
      trace.push({ type: "tools", results: execResults.map(r => ({ name: r.name, ok: r.ok, error: r.error })) });
      for (const tm of toolMessages) messages.push(tm);
      continue;
    }

    if (finish === "length" && continueOnLength) {
      if (continues >= Math.max(0, maxContinues)) { trace.push({ type: "continue_guard", note: "maxContinues reached" }); break; }
      continues++;
      messages.push({ role: "user", content: "continue" });
      trace.push({ type: "continue", count: continues });
      continue;
    }
    break;
  }

  const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
  const finalText = lastAssistant?.content ?? "";
  const reply = typeof replyFormat === "function" ? replyFormat(finalText) : defaultReplyFormat(finalText);

  return { reply, trace, lastResponse, messages };
}

function defaultReplyFormat(text) {
  if (!text) return [];
  const lines = String(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return lines.length ? lines : [String(text)];
}

/* -------------------- Backward Compatibility Layer -------------------- */
// Alte Exportnamen
async function run(deps, opts) { return runUnifiedFlow(deps, opts); }
async function runFlow(deps, opts) { return runUnifiedFlow(deps, opts); }
async function runAiCore(deps, opts) { return runUnifiedFlow(deps, opts); }

/**
 * getAIResponse(context_orig, tokenlimit=4096, sequenceLimit=1000, model="gpt-4o", apiKey=null, options={}, client=null)
 * - Liefert wie v2.46 einen *String* (finaler Assistant-Text).
 * - Intern: baut Adapter auf runUnifiedFlow.
 */
async function getAIResponse(
  context_orig,
  tokenlimit = 4096,
  _sequenceLimit = 1000,    // wird im unified Loop nicht mehr benötigt
  model = "gpt-4o",
  apiKey = null,
  options = {},
  _client = null
) {
  // 1) OpenAI-Client-Adapter (axios-basiert, wie bisher)
  const configuredRaw =
    (options?.endpoint || "").trim() ||
    (process.env.OPENAI_API_URL || "").trim() ||
    (OPENAI_API_URL || "").trim();
  const endpoint = normalizeEndpoint(configuredRaw);

  const headers = { "Content-Type": "application/json", "Connection": "keep-alive" };
  const authKey = apiKey || process.env.OPENAI_API_KEY;
  if (authKey) headers.Authorization = `Bearer ${authKey}`;

  const openai = {
    chat: {
      completions: {
        create: async (payload) => {
          const res = await postWithRetry(endpoint, payload, headers, 3);
          // Rückgabeform kompatibel zum SDK-Shape
          return { choices: res?.data?.choices || [], usage: res?.data?.usage, data: res?.data };
        }
      }
    }
  };

  // 2) Tools-Adapter: Map<string, (args, ctx) => any> → ruft alte Tool-Signatur auf
  const origTools = context_orig?.toolRegistry || {};
  const toolsRegistry = new Map(
    Object.keys(origTools).map(name => {
      const fn = origTools[name];
      return [name, async (args, ctx) => {
        // handoverContext: minimal, aber mit History kompatibel
        const handoverContext = { messages: Array.isArray(ctx?.messages) ? ctx.messages : [] };
        const runtime = { channel_id: context_orig?.channelId || null };
        return fn({ name, arguments: args }, handoverContext, getAIResponse, runtime);
      }];
    })
  );

  // 3) Messages vorbereiten: Zeit + Priming/Persona/Instructions (wie v2.46)
  const messages = Array.isArray(context_orig?.messages) ? [...context_orig.messages] : [];
  const sysParts = [];
  const priming = (process.env.STANDARDPRIMING || "").trim();
  if (priming) sysParts.push(`General rules:\n${priming}`);
  if ((context_orig?.persona || "").trim()) sysParts.push(String(context_orig.persona).trim());
  if ((context_orig?.instructions || "").trim()) sysParts.push(String(context_orig.instructions).trim());
  const sysCombined = sysParts.join("\n\n").trim();
  const nowUtc = new Date().toISOString();

  const initialMessages = [];
  initialMessages.push({ role: "system", content: `Current UTC time: ${nowUtc} <- Use this time whenever asked. Translate to the requested location; if none, use your current location.` });
  if (sysCombined) initialMessages.push({ role: "system", content: sysCombined });
  initialMessages.push(...messages);

  // 4) Tools-Schema (falls vorhanden)
  const tools = Array.isArray(context_orig?.tools) ? context_orig.tools : undefined;

  // 5) Unified Loop ausführen
  const { messages: outMsgs } = await runUnifiedFlow(
    { openai, toolsRegistry, replyFormat: null },
    {
      model,
      messages: initialMessages,
      tools,
      tokenlimit,
      enableTools: true,
      // Defaults übernehmen / optional aus options mappen:
      max_tokens: tokenlimit,
      temperature: options?.temperature,
      stop: options?.stop,
    }
  );

  // 6) Finalen Assistant-Text (String) extrahieren wie früher
  const lastAssistant = [...outMsgs].reverse().find(m => m.role === "assistant");
  const finalText = lastAssistant?.content || "";
  return String(finalText || "");
}

module.exports = {
  // Neuer Kern:
  runUnifiedFlow,
  defaultReplyFormat,
  // Alte Exporte:
  run,
  runFlow,
  runAiCore,
  // Drop-in für bestehende Aufrufer:
  getAIResponse,
};

// aiCore.js — v3.1-compat-fix (Unified Tool Loop + getAIResponse Shim)
// Fixes für AI_HTTP_400:
//  - Keine assistant-Nachrichten mit content:null (content-Feld weglassen, wenn leer)
//  - tool-Nachrichten OHNE "name"-Feld (nur role, tool_call_id, content)
//
// ---------------------------------------------------------------

require("dotenv").config();
const axios = require("axios");
const http = require("http");
const https = require("https");
const { OPENAI_API_URL } = require("./config.js");

/* -------------------- Transport -------------------- */
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
      // WICHTIG: keine "name"-Eigenschaft in tool-Messages!
      toolMessages.push({ role: "tool", tool_call_id: tc.id, content: part });
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
    // Kompat:
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

    // Assistant-Nachricht anhängen – nur gültige Felder
    const assistantMsg = { role: "assistant" };
    if (typeof msg.content === "string" && msg.content.trim().length > 0) {
      assistantMsg.content = msg.content;
    }
    if (hasToolCalls) {
      assistantMsg.tool_calls = msg.tool_calls;
    }
    messages.push(assistantMsg);

    if (hasToolCalls) {
      const { toolMessages, execResults } = await executeAllToolCalls(msg, toolsRegistry, ctx, toolChunkSize);
      trace.push({ type: "tools", results: execResults.map(r => ({ name: r.name, ok: r.ok, error: r.error })) });
      for (const tm of toolMessages) messages.push(tm);
      continue; // Modell erneut fragen
    }

    // Kein Tool-Call – ggf. "continue" bei length
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
async function run(deps, opts) { return runUnifiedFlow(deps, opts); }
async function runFlow(deps, opts) { return runUnifiedFlow(deps, opts); }
async function runAiCore(deps, opts) { return runUnifiedFlow(deps, opts); }

/**
 * getAIResponse(context_orig, tokenlimit=4096, sequenceLimit=1000, model="gpt-4o", apiKey=null, options={}, client=null)
 * - Liefert wie v2.46 einen *String* (finaler Assistant-Text).
 */
async function getAIResponse(
  context_orig,
  tokenlimit = 4096,
  _sequenceLimit = 1000,
  model = "gpt-4o",
  apiKey = null,
  options = {},
  _client = null
) {
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
          return { choices: res?.data?.choices || [], usage: res?.data?.usage, data: res?.data };
        }
      }
    }
  };

  // ToolsRegistry-Adapter: Map<string, (args, ctx) => any> → alte Tool-Signatur
  const origTools = context_orig?.toolRegistry || {};
  const toolsRegistry = new Map(
    Object.keys(origTools).map(name => {
      const fn = origTools[name];
      return [name, async (args, ctx) => {
        const handoverContext = { messages: Array.isArray(ctx?.messages) ? ctx.messages : [] };
        const runtime = { channel_id: context_orig?.channelId || null };
        return fn({ name, arguments: args }, handoverContext, getAIResponse, runtime);
      }];
    })
  );

  // Messages vorbereiten: Zeit + optional Priming/Persona/Instructions
  const messages = Array.isArray(context_orig?.messages) ? [...context_orig.messages] : [];
  const sysParts = [];
  const priming = (process.env.STANDARDPRIMING || "").trim();
  if (priming) sysParts.push(`General rules:\n${priming}`);
  if ((context_orig?.persona || "").trim()) sysParts.push(String(context_orig.persona).trim());
  if ((context_orig?.instructions || "").trim()) sysParts.push(String(context_orig.instructions).trim());
  const sysCombined = sysParts.join("\n\n").trim();
  const nowUtc = new Date().toISOString();

  const initialMessages = [];
  initialMessages.push({ role: "system", content: `Current UTC time: ${nowUtc} <- Use this time whenever asked.` });
  if (sysCombined) initialMessages.push({ role: "system", content: sysCombined });
  initialMessages.push(...messages);

  const tools = Array.isArray(context_orig?.tools) ? context_orig.tools : undefined;

  const { messages: outMsgs } = await runUnifiedFlow(
    { openai, toolsRegistry, replyFormat: null },
    {
      model,
      messages: initialMessages,
      tools,
      tokenlimit,
      enableTools: true,
      max_tokens: tokenlimit,
      temperature: options?.temperature,
      stop: options?.stop,
    }
  );

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
  // Drop-in:
  getAIResponse,
};

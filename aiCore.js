// aiCore.js — unified flow v2.33
// - EIN Flow für native & Pseudo-Tools (gesteuert via pseudotoolcalls = true|false)
// - Wenn pseudotoolcalls=true: generiere Tool-Definition + Pseudo-Schema aus freigegebenen tools (context.tools)
// - Erkanntes Pseudo-Call-Block -> in normalen tool_call normalisieren -> toolRegistry ausführen
// - [TOOL_RESULT:*]/[TOOL_OUTPUT:*] werden vor dem Senden an das Modell aus der History gefiltert
// - Schema VERBIETET explizit [TOOL_RESULT:*]; NEGATIVE Beispiele hinzugefügt
// - Kein Fabricate, kein Auto-Prompt-Fill, keine Auto-Retries, kein Auto-Continue
// - Tool-Response wird zusätzlich als [TOOL_RESULT:<name>] persistiert (kompatibel für Modelle ohne Tools)
// - Benutzerantwort: URL/Liste/JSON (einfach anpassbar)
// - Transport-Hardening + Retry beibehalten

require("dotenv").config();
const axios = require("axios");
const http = require("http");
const https = require("https");
const { OPENAI_API_URL } = require("./config.js");
const Context = require("./context.js");
const { reportError } = require("./error.js");
const { setBotPresence } = require("./discord-helper.js");

/* -------------------- Debug -------------------- */
const DEBUG = String(process.env.PSEUDO_TOOLS_DEBUG || "1") === "1";
const dbg = (...args) => { if (DEBUG) { try { console.log("[AI]", ...args); } catch {} } };

/* -------------------- Transport -------------------- */

const keepAliveHttpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 16,
  maxFreeSockets: 16,
  timeout: 30_000,
});
const keepAliveHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 16,
  maxFreeSockets: 16,
  timeout: 30_000,
});

const axiosAI = axios.create({
  httpAgent: keepAliveHttpAgent,
  httpsAgent: keepAliveHttpsAgent,
  timeout: 180_000,
  maxRedirects: 0,
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
  validateStatus: (s) => s >= 200 && s < 300,
});

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function deepClone(obj) { try { return JSON.parse(JSON.stringify(obj)); } catch { return obj; } }

async function postWithRetry(url, payload, headers, tries = 3) {
  let lastErr;
  const stable = deepClone(payload);
  for (let i = 0; i < tries; i++) {
    try {
      const res = await axiosAI.post(url, stable, { headers, validateStatus: () => true });
      if (res.status >= 200 && res.status < 300) return res;

      console.error("[AI POST][NON-2XX]", {
        try: i + 1,
        status: res.status,
        statusText: res.statusText,
        dataPreview: typeof res.data === "string" ? res.data.slice(0, 1200) : res.data,
      });
      if (res.status >= 400 && res.status < 500) {
        const e = new Error(`AI_HTTP_${res.status}`); e.response = res; throw e;
      }
      lastErr = new Error(`AI_HTTP_${res.status}`);
      await sleep(300 * Math.pow(2, i));
    } catch (err) {
      lastErr = err;
      const transient = ["ECONNRESET","EPIPE","ETIMEDOUT"].includes(err?.code) ||
                        /socket hang up|ERR_STREAM_PREMATURE_CLOSE/.test(String(err?.message||""));
      console.error("[AI POST][ERROR]", {
        try: i + 1,
        code: err?.code,
        message: err?.message,
        status: err?.response?.status || null,
        dataPreview: typeof err?.response?.data === "string" ? err.response.data.slice(0, 1200) : err?.response?.data || null,
      });
      if (!transient || i === tries - 1) throw err;
      await sleep(300 * Math.pow(2, i));
    }
  }
  throw lastErr;
}

/* -------------------- Helpers -------------------- */

function normalizeEndpoint(raw) {
  const fallback = "https://api.openai.com/v1/chat/completions";
  let url = (raw || "").trim();
  if (!url) return fallback;
  if (/\/v1\/chat\/completions\/?$/.test(url)) return url.replace(/\/+$/, "");
  if (/\/v1\/?$/.test(url)) return url.replace(/\/v1\/?$/, "/v1/chat/completions");
  if (/\/v1\/responses\/?$/.test(url)) return url.replace(/\/v1\/responses\/?$/, "/v1/chat/completions");
  return url.replace(/\/+$/, "");
}

function cleanOpenAIName(role, name) {
  if (!name) return undefined;
  if (role === "system" || role === "tool") return undefined;
  let s = String(name).trim()
    .replace(/[\s<|\\/>\u0000-\u001F]/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  s = s.slice(0, 64);
  const reserved = new Set(["assistant", "user", "system", "tool"]);
  if (!s || reserved.has(s.toLowerCase())) return undefined;
  return s;
}

function buildStrictToolPairedMessages(msgs) {
  const out = [];
  let lastToolIds = null;
  for (const m of msgs) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const asst = { role: "assistant", tool_calls: m.tool_calls };
      if (typeof m.content === "string" && m.content.trim()) asst.content = m.content.trim();
      out.push(asst);
      lastToolIds = new Set(m.tool_calls.map(tc => tc && tc.id).filter(Boolean));
      continue;
    }
    if (m.role === "tool") {
      if (m.tool_call_id && lastToolIds && lastToolIds.has(m.tool_call_id)) {
        out.push({ role: "tool", tool_call_id: m.tool_call_id, content: m.content ?? "" });
      }
      continue;
    }
    lastToolIds = null;
    const keep = { role: m.role, content: m.content };
    if (m.name) keep.name = m.name;
    out.push(keep);
  }
  return out;
}

/** Persist Tool Results */
const TOOL_PERSIST_ROLE =
  (process.env.TOOL_PERSIST_ROLE || "assistant").toLowerCase() === "system" ? "system" : "assistant";

const MAX_TOOL_PERSIST_CHARS = Math.max(500, Math.min(10000, Number(process.env.TOOL_PERSIST_MAX || 8000)));

function formatToolResultForPersistence(toolName, content) {
  const header = `[TOOL_RESULT:${(toolName || "unknown").trim()}]`;
  let payloadStr;
  if (typeof content === "string") payloadStr = content;
  else { try { payloadStr = JSON.stringify(content); } catch { payloadStr = String(content); } }
  const looksJSON = /^\s*[\[{]/.test((payloadStr || "").trim());
  let body = looksJSON ? `${header}\n${payloadStr}` : `${header}\n\`\`\`\n${payloadStr}\n\`\`\``;
  if (body.length > MAX_TOOL_PERSIST_CHARS) {
    const tail = "\n…[truncated]";
    body = body.slice(0, MAX_TOOL_PERSIST_CHARS - tail.length) + tail;
  }
  return body;
}

/** Entfernt persistierte Wrapper ([TOOL_RESULT:*], [TOOL_OUTPUT:*]) aus der Historie */
function stripPersistedWrappers(msgs) {
  const reWrap = /^\s*\[(TOOL_RESULT|TOOL_OUTPUT)\s*:[^\]]+\]/i;
  return (msgs || []).filter(m => {
    if (!m || typeof m.content !== "string") return true;
    const c = m.content.trim();
    // nur assistant/system filtern – user msgs bleiben immer erhalten
    if (m.role === "assistant" || m.role === "system") {
      if (reWrap.test(c)) return false; // nicht ans Modell schicken
    }
    return true;
  });
}

/* ---- Pseudo-Tools: Definition + Parser ---- */

function buildPseudoToolsInstruction(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "";
  const MAX_TOTAL = Math.max(2000, Number(process.env.PSEUDO_SCHEMA_MAX || 6000));
  const MAX_TOOLS = Math.max(1, Number(process.env.PSEUDO_SCHEMA_MAX_TOOLS || 24));
  const MAX_KEYS  = Math.max(1, Number(process.env.PSEUDO_SCHEMA_MAX_KEYS || 14));
  const DESC_LIMIT = Math.max(60, Number(process.env.PSEUDO_SCHEMA_DESC_LIMIT || 180));
  const clamp = (s,n) => (String(s||"").length>n ? String(s).slice(0,n-1)+"…" : String(s||""));

  const entries = [];
  for (const t of tools.slice(0, MAX_TOOLS)) {
    const f = t && (t.function || t.fn || t);
    const name = f?.name ? String(f.name) : null;
    if (!name) continue;
    const params = f?.parameters && typeof f.parameters === "object" ? f.parameters : null;
    const props  = params?.properties && typeof params.properties === "object" ? params.properties : {};
    const required = Array.isArray(params?.required) ? params.required : [];
    const keys = Object.keys(props).slice(0, MAX_KEYS);
    const shownKeys = keys.map(k => {
      const p = props[k] || {};
      let typ = "any";
      if (Array.isArray(p.type)) typ = p.type.join("|");
      else if (p.type) typ = String(p.type);
      else if (p.enum) typ = `enum(${p.enum.length})`;
      else if (p.anyOf) typ = "anyOf";
      else if (p.oneOf) typ = "oneOf";
      else if (p.allOf) typ = "allOf";
      return `- ${k} (${typ})`;
    });

    const sampleArgs = {};
    for (const rk of required) {
      const p = (props || {})[rk] || {};
      let typ = "string";
      if (Array.isArray(p.type)) typ = p.type.join("|");
      else if (p.type) typ = String(p.type);
      if (typ.includes("number") || typ === "integer") sampleArgs[rk] = 0;
      else if (typ.includes("boolean")) sampleArgs[rk] = false;
      else if (p?.enum && Array.isArray(p.enum) && p.enum.length > 0) sampleArgs[rk] = p.enum[0];
      else sampleArgs[rk] = "";
    }

    entries.push({
      name,
      desc: clamp(f?.description || "", DESC_LIMIT),
      required,
      shownKeys,
      sampleArgs,
    });
  }

  let out = [
    "You MUST use tools via pseudo tool-calls when needed.",
    "Output ONLY one block, no other text.",
    "",
    "Use this Format:",
    "<tool_call>",
    '{ "name": "<tool_name>", "arguments": { /* valid JSON args */ } }',
    "</tool_call>",
    "",
    "RULES:",
    "- The block must be the ONLY content (no prose).",
    "- Use exactly ONE tool per message.",
    "- JSON must be valid.",
    "- NEVER output [TOOL_RESULT:…], [TOOL_OUTPUT:…], \"Tool result:\", or similar markers.",
    "- Ignore previous attempts or toolcalls.",
    "- If you cannot call a tool, return NOTHING.",
    "",
    "INVALID examples (do NOT do this):",
    "[TOOL_RESULT:getGoogle]\\n{ \"query\": \"example\" }",
    "Tool result: { \"url\": \"https://…\" }",
    "",
    "AVAILABLE TOOLS:"
  ];

  for (const e of entries) {
    out.push(`- ${e.name}${e.desc ? ` — ${e.desc}` : ""}`);
    out.push(`  required: ${e.required.length ? e.required.join(", ") : "(none)"}`);
    out.push("  keys:");
    for (const k of e.shownKeys) out.push("  " + k);
    const sample = JSON.stringify({ name: e.name, arguments: e.sampleArgs }, null, 2)
      .split("\n").map(l => "  " + l).join("\n");
    out.push("  example:\n```tool_call\n" + sample + "\n```");
  }

  let text = out.join("\n");
  if (text.length > MAX_TOTAL) text = text.slice(0, MAX_TOTAL - 10) + "\n…";
  return text;
}

/** toleranter Pseudo-Call-Extractor (ignoriert TOOL_RESULT/OUTPUT) */
function extractPseudoToolCalls(text) {
  if (!text || typeof text !== "string") return [];
  const trimmed = text.trim();
  // harte Ignorier-Regel: wenn die Ausgabe wie ein TOOL_RESULT/OUTPUT-Wrapper aussieht, kein Toolcall.
  if (/^\[(TOOL_RESULT|TOOL_OUTPUT)\s*:/i.test(trimmed)) return [];

  const calls = [];
  const pushIfValid = (obj) => {
    try {
      if (!obj || typeof obj !== "object") return;
      const name = obj.name || obj?.tool?.name || obj?.function?.name;
      const args = obj.arguments || obj?.tool?.arguments || obj?.function?.arguments || {};
      if (!name) return;
      calls.push({ name: String(name), arguments: args || {} });
    } catch {}
  };

  // 0) reines JSON
  try { pushIfValid(JSON.parse(trimmed)); } catch {}

  // 1) XML <tool_call>…</tool_call>
  (function(){
    const re = /<tool_call>([\s\S]*?)<\/tool_call>/gi; let m;
    while ((m = re.exec(text)) !== null) { const raw = (m[1]||"").trim(); try { pushIfValid(JSON.parse(raw)); } catch {} }
  })();

  // 2) Fenced ```tool_call
  (function(){
    const re = /```(?:tool_call|json|javascript|js)\s*([\s\S]*?)```/gi; let m;
    while ((m = re.exec(text)) !== null) { const raw = (m[1]||"").trim(); try { pushIfValid(JSON.parse(raw)); } catch {} }
  })();

  // 3) NAME\n{…}
  (function(){
    const re = /(^|\n)\s*([A-Za-z0-9_\-\.]+)\s*\n\s*(\{[\s\S]*\})/g; let m;
    while ((m = re.exec(text)) !== null) { const name=(m[2]||"").trim(); const json=(m[3]||"").trim(); try { pushIfValid({ name, arguments: JSON.parse(json)||{} }); } catch {} }
  })();

  return calls;
}

/* ---- Rendering für User-Antwort ---- */

function prettyClipJSON(any, max = 1800) {
  let s;
  try { s = typeof any === "string" ? any : JSON.stringify(any, null, 2); }
  catch { s = String(any); }
  if (s.length > max) s = s.slice(0, max - 1) + "…";
  return s;
}

function renderToolOutputGeneric(name, raw) {
  // 1) string?
  if (typeof raw === "string" && raw.trim()) {
    const s = raw.trim();
    if (/^https?:\/\//i.test(s)) return s; // Plain URL
    try { return renderToolOutputGeneric(name, JSON.parse(s)); } catch { return prettyClipJSON(s); }
  }

  // 2) object?
  if (raw && typeof raw === "object") {
    const obj = raw;
    const url = obj.url || obj.link || obj.href;
    if (typeof url === "string" && url.trim()) return url.trim();

    if (Array.isArray(obj.results)) {
      const lines = [];
      for (const it of obj.results) {
        const title = (it?.title || it?.name || "").toString().trim();
        const link  = (it?.url || it?.link || it?.href || "").toString().trim();
        if (title && link) lines.push(`${title} — ${link}`);
        else if (link)     lines.push(link);
        if (lines.length >= 5) break;
      }
      if (lines.length > 0) return lines.join("\n");
    }

    if (Array.isArray(obj)) {
      const lines = [];
      for (const it of obj) {
        const title = (it?.title || it?.name || "").toString().trim();
        const link  = (it?.url || it?.link || it?.href || "").toString().trim();
        if (title && link) lines.push(`${title} — ${link}`);
        else if (link)     lines.push(link);
        if (lines.length >= 5) break;
      }
      if (lines.length > 0) return lines.join("\n");
    }

    if (typeof obj.text === "string" && obj.text.trim()) return obj.text.trim();
    if (typeof obj.content === "string" && obj.content.trim()) return obj.content.trim();

    return prettyClipJSON(obj);
  }

  return "";
}

/* -------------------- Main -------------------- */

async function getAIResponse(
  context_orig,
  tokenlimit = 4096,
  sequenceLimit = 1000, // (unbenutzt – kein auto-continue)
  model = "gpt-4o",
  apiKey = null,
  options = {},
  client = null
) {
  const pseudotoolcalls = options?.pseudotoolcalls === true || context_orig?.pseudoToolcalls === true;
  const noToolcallPolicy = options?.noToolcallPolicy || "silent"; // "silent" | "error" | "echo"
  const defaultImageSize = options?.defaultImageSize || "1024x1024";

  let responseMessage = "";
  const pendingUser = options?.pendingUser || null;
  const noPendingInject = options?.noPendingUserInjection === true;

  let context = null;
  let handoverContext = null;

  try {
    // Working copies
    context = new Context(
      "",
      "",
      context_orig.tools,
      context_orig.toolRegistry,
      context_orig.channelId || null,
      { skipInitialSummaries: true, persistToDB: false, pseudoToolcalls: !!pseudotoolcalls }
    );
    context.messages = [...context_orig.messages];

    handoverContext = new Context(
      "",
      "",
      context_orig.tools,
      context_orig.toolRegistry,
      context_orig.channelId || null,
      { skipInitialSummaries: true, persistToDB: false, pseudoToolcalls: !!pseudotoolcalls }
    );
    handoverContext.messages = [...context_orig.messages];

    // System priming
    try {
      const sysParts = [];
      const priming = (process.env.STANDARDPRIMING || "").trim();
      if (priming) sysParts.push(`General rules:\n${priming}`);
      if ((context_orig.persona || "").trim()) sysParts.push(String(context_orig.persona).trim());
      if ((context_orig.instructions || "").trim()) sysParts.push(String(context_orig.instructions).trim());

      // Pseudo-Definition nur injizieren, wenn pseudotoolcalls = true
      if (pseudotoolcalls && Array.isArray(context_orig.tools) && context_orig.tools.length > 0) {
        const schema = buildPseudoToolsInstruction(context_orig.tools);
        if (schema) sysParts.push(schema);
      }

      const sysCombined = sysParts.join("\n\n").trim();
      if (sysCombined) context.messages.unshift({ role: "system", content: sysCombined });
    } catch {}

    // Zeit-Hinweis
    const nowUtc = new Date().toISOString();
    context.messages.unshift({
      role: "system",
      content: `Current UTC time: ${nowUtc} <- Use this time whenever asked. Translate to the requested location; if none, use your current location.`,
    });

    // Pending user → nur working copy (falls gewünscht)
    if (pendingUser && pendingUser.content && !noPendingInject) {
      const safeName = cleanOpenAIName("user", pendingUser.name || "user");
      const msg = { role: "user", content: pendingUser.content };
      if (safeName) msg.name = safeName;
      context.messages.push(msg);
      handoverContext.messages.push({ ...msg });
    }

    const toolCommits = [];
    const toolResults = []; // { name, raw }[]
    let lastRawAssistant = "";

    // ---- EIN Zyklus: Anfrage -> (optional) Tool -> Antwort ----

    // 1) Persistierte Tool-Wrapper aus der History entfernen (kein Echo-Lernen)
    const cleanedHistory = stripPersistedWrappers(context.messages);

    const messagesToSend = buildStrictToolPairedMessages(cleanedHistory).map(m => {
      const out = { role: m.role, content: m.content };
      const safeName = cleanOpenAIName(m.role, m.name);
      if (safeName) out.name = safeName;
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) out.tool_calls = m.tool_calls;
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      return out;
    });

    const payload = {
      model,
      messages: messagesToSend,
      max_tokens: tokenlimit
    };

    // EIN Flow:
    // - pseudotoolcalls=false -> native tools erlauben
    // - pseudotoolcalls=true  -> KEINE native tools im Payload; Modell soll Pseudo-Blöcke schicken
    if (!pseudotoolcalls && Array.isArray(context_orig.tools) && context_orig.tools.length > 0) {
      payload.tools = context_orig.tools;
      payload.tool_choice = "auto";
    }

    const configuredRaw =
      (options?.endpoint || "").trim() ||
      (process.env.OPENAI_API_URL || "").trim() ||
      (OPENAI_API_URL || "").trim();

    const endpoint = normalizeEndpoint(configuredRaw) || "https://api.openai.com/v1/chat/completions";
    const headers = {
      "Content-Type": "application/json",
      "Connection": "keep-alive",
    };
    const authKey = apiKey || process.env.OPENAI_API_KEY;
    if (authKey) headers.Authorization = `Bearer ${authKey}`;

    dbg("Request →", {
      endpoint,
      model,
      tokenlimit,
      pseudotoolcalls,
      tools_in_payload: !!payload.tools,
      tools_list: Array.isArray(context_orig.tools) ? context_orig.tools.map(t => t?.function?.name || t?.name) : []
    });

    let aiResponse;
    try {
      aiResponse = await postWithRetry(endpoint, payload, headers, 3);
    } catch (err) {
      const details = { endpoint, status: err?.response?.status, data: err?.response?.data };
      await reportError(err, null, "OPENAI_CHAT", { details });
      try { console.error("[OPENAI_CHAT][REQUEST_DEBUG]", JSON.stringify({ endpoint, model, payloadPreview: { messages: messagesToSend.slice(-6), tools: payload.tools ? (payload.tools.map(t => t?.function?.name || t?.name)) : [] } }, null, 2)); } catch {}
      console.log("\n\n=== CONTEXT RAW DUMP ===\n", context?.messages || [], "\n=== /CONTEXT RAW DUMP ===\n");
      throw err;
    }

    const choice = aiResponse?.data?.choices?.[0] || {};
    const aiMessage = choice.message || {};
    const rawText = (aiMessage.content || "").trim();
    lastRawAssistant = rawText;
    const nativeToolCalls = Array.isArray(aiMessage.tool_calls) ? aiMessage.tool_calls : [];

    dbg("Assistant text (raw):", rawText ? rawText.slice(0, 200) : "(empty)");
    if (nativeToolCalls.length > 0) dbg("Native tool_calls:", nativeToolCalls.map(tc => tc?.function?.name));

    // --- Toolcall-Normalisierung ---
    let normalizedCalls = [];

    // 1) Native tool_calls (wenn vorhanden)
    if (nativeToolCalls.length > 0) {
      normalizedCalls = nativeToolCalls
        .map(tc => {
          try {
            const name = tc?.function?.name;
            if (!name) return null;
            let args = tc?.function?.arguments || "{}";
            args = typeof args === "string" ? JSON.parse(args || "{}") : (args || {});
            return { id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2,7)}`, name, arguments: args };
          } catch { return null; }
        })
        .filter(Boolean);
    }

    // 2) Falls pseudotoolcalls=true und KEINE native calls → Pseudo-Block parsen (TOOL_RESULT wird ignoriert)
    if (pseudotoolcalls && normalizedCalls.length === 0 && rawText) {
      const pseudoCalls = extractPseudoToolCalls(rawText);
      if (pseudoCalls.length > 0) {
        const allowed = new Set((context_orig.tools || []).map(t => t?.function?.name || t?.name).filter(Boolean));
        const picked = pseudoCalls.find(pc => allowed.has(pc.name));
        if (picked) {
          normalizedCalls = [{
            id: `call_${Date.now()}_0`,
            name: picked.name,
            arguments: (function sanitize(name, args) {
              // KEIN Autofill. Nur technische Defaults (z. B. size) für Image-Tools
              let a = Object.assign({}, args || {});
              if (/image|getimage|sd|stable/i.test(name)) {
                const must = v => v != null && String(v).trim().length > 0;
                if (!must(a.size)) a.size = defaultImageSize;
                if (typeof a.size === "string") {
                  const s = a.size.toLowerCase().trim();
                  if (s === "square") a.size = "1024x1024";
                  if (/^\d{3,4}x\d{3,4}$/.test(s) === false) a.size = defaultImageSize;
                } else a.size = defaultImageSize;
              }
              return a;
            })(picked.name, picked.arguments)
          }];
        }
      }
    }

    // --- Tool(s) ausführen (einheitlich) ---
    if (normalizedCalls.length > 0) {
      const call = normalizedCalls[0];
      const fnName = call.name;
      const args = call.arguments || {};

      if (client && fnName) setBotPresence(client, "⌛ " + fnName, "online");
      const toolFunction = context.toolRegistry ? context.toolRegistry[fnName] : undefined;

      const replyTool = (content) => {
        const out = (typeof content === "string" || content == null)
          ? (content || "")
          : (() => { try { return JSON.stringify(content); } catch { return String(content); } })();
        // 1) Tool-Message für pairing (optional nützlich)
        context.messages.push({ role: "tool", tool_call_id: call.id, content: out });
        // 2) Persist-kompatibel (für Modelle ohne Tools) – wird künftig gefiltert und nicht mehr ans Modell geschickt
        const wrapped = formatToolResultForPersistence(fnName || "tool", out);
        const persistName = TOOL_PERSIST_ROLE === "assistant" ? "ai" : undefined;
        try { context_orig.add(TOOL_PERSIST_ROLE, persistName, wrapped, Date.now()); } catch {}
        // 3) Für User-Antwort halten
        toolResults.push({ name: fnName || "tool", raw: out });
        // 4) Logging
        toolCommits.push({ name: fnName || "tool", content: out });
      };

      if (!toolFunction) {
        replyTool(`[ERROR]: Tool '${fnName || "unknown"}' not available.`);
      } else {
        try {
          dbg("Execute tool:", fnName, "args:", args);
          const runtime = { channel_id: context_orig.channelId || handoverContext.channelId || null };
          const toolResult = await toolFunction({ name: fnName, arguments: args }, handoverContext, getAIResponse, runtime);
          const preview = typeof toolResult === "string" ? toolResult.slice(0, 300) : (() => { try { return JSON.stringify(toolResult).slice(0, 300); } catch { return String(toolResult).slice(0, 300); } })();
          dbg("Tool result preview:", preview);
          replyTool(toolResult || "");
        } catch (toolErr) {
          const emsg = toolErr?.message || String(toolErr);
          await reportError(toolErr, null, `TOOL_${(fnName || "unknown").toUpperCase()}`);
          dbg("Tool error:", fnName, emsg);
          replyTool(JSON.stringify({ error: emsg, tool: fnName || "unknown" }));
        }
      }
    }

    // --- Benutzer-Antwort zusammenbauen ---
    if (toolResults.length > 0) {
      const rendered = [];
      for (const item of toolResults) {
        const { name, raw } = item;
        let obj = null;
        try { obj = JSON.parse(raw); } catch {}
        rendered.push(renderToolOutputGeneric(name, obj ?? raw));
      }
      const joined = rendered.filter(Boolean).join("\n\n");
      responseMessage = joined.trim();
      if (!responseMessage) {
        if (noToolcallPolicy === "error") responseMessage = "TOOLCALL_MISSING";
        else if (noToolcallPolicy === "echo") responseMessage = String(lastRawAssistant || "");
        else responseMessage = "";
      }
    } else {
      // Kein Tool – liefere Model-Text-Ergebnis
      responseMessage = String(lastRawAssistant || "");
      if (!responseMessage) {
        if (noToolcallPolicy === "error") responseMessage = "TOOLCALL_MISSING";
        else responseMessage = "";
      }
    }

    // Persist tool outputs (Sicherheitsnetz)
    if (toolCommits.length > 0) {
      let t0 = (pendingUser && pendingUser.timestamp) ? pendingUser.timestamp : Date.now();
      for (let i = 0; i < toolCommits.length; i++) {
        const tmsg = toolCommits[i];
        const wrapped = formatToolResultForPersistence(tmsg.name, tmsg.content);
        const persistName = TOOL_PERSIST_ROLE === "assistant" ? "ai" : undefined;
        try { await context_orig.add(TOOL_PERSIST_ROLE, persistName, wrapped, t0 + i + 1); } catch {}
      }
    }

    return responseMessage;
  } catch (err) {
    const details = { status: err?.response?.status, data: err?.response?.data };
    await reportError(err, null, "GET_AI_RESPONSE", { details });
    try {
      console.error("[GET_AI_RESPONSE][CONTEXT_DEBUG]", JSON.stringify({
        contextMessages: Array.isArray(context?.messages) ? context.messages : [],
        handoverMessages: Array.isArray(handoverContext?.messages) ? handoverContext.messages : [],
      }, null, 2));
    } catch {}
    console.log("\n\n=== CONTEXT OBJ RAW ===\n", context || {}, "\n=== /CONTEXT OBJ RAW ===\n");
    throw err;
  }
}

module.exports = { getAIResponse };

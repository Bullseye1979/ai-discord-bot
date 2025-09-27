// aiCore.js — v3.1 (Unified Tool Loop + Backward Compatibility)
// -------------------------------------------------------------
// Was ist neu?
// - Ein einziger, einfacher Loop: Modell → (tool_calls?) → Tools → Modell … bis fertig.
// - Kein separater Finalizer-Flow nötig.
// - Große Tool-Outputs werden als mehrere tool-Nachrichten gechunked.
// - Rückgabe bleibt kompatibel: { reply, trace, lastResponse, messages }.
// Kompatibilität:
// - Alte Flags werden akzeptiert und sanft ignoriert/abgebildet: pseudotoolcalls, postToolFinalize,
//   tools_in_payload, tokenlimit, continueOnLength, etc.
// - Alte Export-Namen bleiben erhalten: run, runFlow, runAiCore.
// Erwartete Umgebung:
// - deps.openai: OpenAI-Client mit chat.completions.create(...)
// - deps.toolsRegistry: Map<string, async (args, ctx) => any>
// - deps.replyFormat?: (assistantText) => string[]  // ["Name: Text", ...] für euer Frontend

const DEFAULTS = {
  maxToolLoops: 8,
  maxContinues: 2,
  toolChunkSize: 12000,     // ~Zeichen; bei Bedarf anpassen
  enableTools: true,
  continueOnLength: true,   // alte Semantik: bei length ein "continue" senden
};

function chunkString(str, size) {
  if (!str || typeof str !== "string" || size <= 0) return [String(str ?? "")];
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out;
}

/** Führt einen einzelnen Tool-Aufruf über das Registry aus. */
async function runSingleToolCall(toolCall, toolsRegistry, ctx) {
  const { id, function: fn } = toolCall || {};
  const toolName = fn?.name;
  const rawArgs = fn?.arguments ?? "{}";

  if (!toolsRegistry?.has(toolName)) {
    return {
      id,
      name: toolName,
      ok: false,
      error: `Unknown tool: ${toolName}`,
      output: `{"error":"Unknown tool: ${toolName}"}`,
    };
  }

  let parsed;
  try {
    parsed = rawArgs ? JSON.parse(rawArgs) : {};
  } catch (e) {
    return {
      id,
      name: toolName,
      ok: false,
      error: `Invalid JSON arguments for ${toolName}: ${e.message}`,
      output: `{"error":"Invalid arguments"}`,
    };
  }

  try {
    const toolFn = toolsRegistry.get(toolName);
    const result = await toolFn(parsed, ctx);
    const output = (typeof result === "string") ? result : JSON.stringify(result ?? {});
    return { id, name: toolName, ok: true, output };
  } catch (e) {
    return {
      id,
      name: toolName,
      ok: false,
      error: e?.message || String(e),
      output: JSON.stringify({ error: e?.message || String(e) }),
    };
  }
}

/** Führt alle Tool-Calls des letzten Assistant-Turns aus; baut tool-Nachrichten (mit Chunking). */
async function executeAllToolCalls(lastAssistant, toolsRegistry, ctx, toolChunkSize) {
  const toolCalls = lastAssistant?.tool_calls || [];
  const toolMessages = [];
  const execResults = [];

  for (const tc of toolCalls) {
    const res = await runSingleToolCall(tc, toolsRegistry, ctx);
    execResults.push(res);

    const chunks = chunkString(res.output ?? "", toolChunkSize);
    for (const part of chunks) {
      toolMessages.push({
        role: "tool",
        tool_call_id: tc.id,
        name: res.name || tc.function?.name,
        content: part,
      });
    }
  }

  return { toolMessages, execResults };
}

/** Modellaufruf (ein Turn). */
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

/**
 * Neuer Kern: Unified Flow
 * deps: { openai, toolsRegistry, replyFormat? }
 * opts: { model, messages, tools?, enableTools?, maxToolLoops?, maxContinues?, toolChunkSize?, temperature?, max_tokens?, stop?, ctx? }
 */
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
    // Kompat-Optionen (werden ignoriert oder abgebildet)
    // Alte Namen:
    pseudotoolcalls,           // no-op: unified loop behandelt "pseudo" & "native" identisch
    postToolFinalize,          // no-op: nicht mehr nötig
    tools_in_payload,          // no-op: ggf. nur Logging in Altversion
    tokenlimit,                // map auf max_tokens falls gesetzt
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
    if (loops > Math.max(1, maxToolLoops)) {
      trace.push({ type: "guard", note: "maxToolLoops reached" });
      break;
    }

    const tool_choice = enableTools ? undefined : "none";

    const resp = await askModel(openai, {
      model,
      messages,
      tools: enableTools ? tools : undefined,
      tool_choice,
      temperature,
      max_tokens: effMaxTokens,
      stop,
    });

    lastResponse = resp;
    const choice = resp?.choices?.[0] || {};
    const msg = choice.message || {};
    const finish = choice.finish_reason;
    const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;

    trace.push({ type: "model", finish, hasToolCalls, usage: resp?.usage });

    // Assistant-Nachricht anhängen
    messages.push({
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: msg.tool_calls ?? undefined,
    });

    if (hasToolCalls) {
      // Tools ausführen und als tool-Nachrichten anhängen
      const { toolMessages, execResults } = await executeAllToolCalls(msg, toolsRegistry, ctx, toolChunkSize);
      trace.push({ type: "tools", results: execResults.map(r => ({ name: r.name, ok: r.ok, error: r.error })) });
      for (const tm of toolMessages) messages.push(tm);
      continue; // Modell erneut fragen
    }

    // Kein Tool-Call – ggf. "continue" bei length
    if (finish === "length" && continueOnLength) {
      if (continues >= Math.max(0, maxContinues)) {
        trace.push({ type: "continue_guard", note: "maxContinues reached" });
        break;
      }
      continues++;
      messages.push({ role: "user", content: "continue" });
      trace.push({ type: "continue", count: continues });
      continue;
    }

    // Fertig
    break;
  }

  // Finalen Assistant-Text finden
  const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
  const finalText = lastAssistant?.content ?? "";

  // Reply normalisieren (Frontend erwartet ["Name: Text", ...])
  const reply = typeof replyFormat === "function" ? replyFormat(finalText) : defaultReplyFormat(finalText);

  return { reply, trace, lastResponse, messages };
}

/** Fallback-Formatter: gibt Zeilen aus oder eine Einzelzeile. */
function defaultReplyFormat(text) {
  if (!text) return [];
  const lines = String(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return lines.length ? lines : [String(text)];
}

/* ------------------------------------------------------------------------- */
/* Backward-Compatibility Layer                                              */
/* ------------------------------------------------------------------------- */

/**
 * Alte Signaturen rufen intern den neuen Kern auf.
 * Wir lassen bewusst viele Option-Namen zu und leiten sie weiter.
 */
async function run(deps, opts) {
  return runUnifiedFlow(deps, opts);
}
async function runFlow(deps, opts) {
  return runUnifiedFlow(deps, opts);
}
async function runAiCore(deps, opts) {
  return runUnifiedFlow(deps, opts);
}

module.exports = {
  // Neuer Kern:
  runUnifiedFlow,
  defaultReplyFormat,
  // Alte Exporte:
  run,
  runFlow,
  runAiCore,
};

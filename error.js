// error.js — v2.2 (autark, mit Channel-Ausgabe ohne discord-helper)
// Zentrale Log- und Error-Behandlung mit Leveln (INFO, WARN, ERROR, FATAL)

const util = require("util");

const LEVELS = ["INFO", "WARN", "ERROR", "FATAL"];
const DEFAULTS = {
  sinks: { console: true },           // Console-Sink an/aus
  defaultTag: "APP",
  redactHeaders: ["authorization", "proxy-authorization"],
  maxDataPreview: 2000,
  maxCodeBlock: 1200,
  chunkHard: 2000,                     // Discord Hardlimit
  chunkSoft: 1900,                     // Softlimit für saubere Umbrüche
};

let _cfg = { ...DEFAULTS };

/** Konfiguration setzen */
function configure(opts = {}) {
  _cfg = { ..._cfg, ...opts, sinks: { ..._cfg.sinks, ...(opts.sinks || {}) } };
}

/** Mini-Chunking (ohne discord-helper) */
function splitIntoChunks(text, hardLimit = _cfg.chunkHard, softLimit = _cfg.chunkSoft) {
  if (!text) return [];
  const chunks = [];
  let remaining = String(text);

  const hardSplit = (s) => s.match(new RegExp(`[\\s\\S]{1,${hardLimit}}`, "g")) || [];

  while (remaining.length > softLimit) {
    let cut = remaining.lastIndexOf("\n\n", softLimit);
    if (cut === -1) cut = remaining.lastIndexOf("\n", softLimit);
    if (cut === -1) cut = remaining.lastIndexOf(" ", softLimit);
    if (cut === -1) cut = softLimit;

    const part = remaining.slice(0, cut).trim();
    if (!part) {
      const [first] = hardSplit(remaining);
      chunks.push(first);
      remaining = remaining.slice(first.length);
    } else {
      chunks.push(part);
      remaining = remaining.slice(cut).trimStart();
    }
  }
  if (remaining.length) chunks.push(remaining);
  return chunks.flatMap(hardSplit);
}

/** Header-Redaktion */
function redactHeaders(h = {}) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    const lower = String(k).toLowerCase();
    out[k] = _cfg.redactHeaders.includes(lower) ? "***" : v;
  }
  return out;
}

/** Fehler/Objekt normalisieren (Axios & generisch) */
function normalizeError(err, tag = _cfg.defaultTag, level = "ERROR") {
  if (!LEVELS.includes(level)) level = "ERROR";

  if (typeof err === "string") {
    return { level, tag, message: err };
  }

  const res = err?.response;
  const cfg = res?.config || err?.config;

  if (res) {
    let data = res?.data;
    if (typeof data === "string") {
      data = data.slice(0, _cfg.maxDataPreview);
    } else if (data && typeof data === "object") {
      try {
        const json = JSON.stringify(data);
        data = json.length > _cfg.maxDataPreview ? json.slice(0, _cfg.maxDataPreview) + "…" : json;
      } catch {
        data = util.inspect(data, { depth: 1 }).slice(0, _cfg.maxDataPreview);
      }
    }

    return {
      level,
      tag,
      message: err.message || res?.statusText || "Request failed",
      status: res?.status ?? null,
      statusText: res?.statusText ?? null,
      code: err?.code ?? null,
      requestId: res?.headers?.["x-request-id"] || null,
      config: cfg ? {
        method: cfg.method,
        url: cfg.url,
        headers: redactHeaders(cfg.headers),
      } : undefined,
      data,
    };
  }

  return {
    level,
    tag: err?.tag || tag,
    message: err?.message || String(err),
    code: err?.code ?? null,
  };
}

/** Discord-Format */
function formatForChannel(parsed) {
  const lines = [];
  const push = (label, val) => {
    if (val === undefined || val === null || val === "") return;
    lines.push(`**${label}:** ${String(val)}`);
  };

  lines.push(`🚨 **${parsed.level}** — **${parsed.tag || "APP"}**`);
  push("Status", parsed.status != null ? `${parsed.status} ${parsed.statusText || ""}`.trim() : null);
  push("Code", parsed.code);
  push("Request-ID", parsed.requestId);
  push("Message", parsed.message);
  if (parsed.config?.url) push("URL", parsed.config.url);
  if (parsed.config?.method) push("Method", String(parsed.config.method).toUpperCase());

  if (parsed.data) {
    const preview = typeof parsed.data === "string" ? parsed.data : util.inspect(parsed.data, { depth: 1 });
    lines.push("\n**Response (preview):**");
    lines.push("```");
    lines.push(preview.slice(0, _cfg.maxCodeBlock));
    lines.push("```");
  }
  return lines.join("\n");
}

/** Console-Sink */
function sinkConsole(parsed) {
  if (!_cfg.sinks.console) return;
  const base = `[${parsed.level}] [${parsed.tag || "APP"}] ${parsed.message || ""}`;
  try { process.stderr.write(base + "\n"); } catch {}
}

/** Channel-Sink (ohne discord-helper) */
async function sinkChannel(parsed, channel) {
  if (!channel || typeof channel.send !== "function") return;
  try {
    const text = formatForChannel(parsed);
    const parts = splitIntoChunks(text);
    for (const p of parts) {
      await channel.send({ content: p });
    }
  } catch {
    // nie crashen
  }
}

/** High-Level API */
async function reportError(err, channel = null, tag = _cfg.defaultTag, level = "ERROR") {
  const parsed = normalizeError(err, tag, level);
  sinkConsole(parsed);
  await sinkChannel(parsed, channel);
  return parsed;
}

/** Info/Warn ohne Exception */
async function log(level, message, { tag = _cfg.defaultTag, channel = null } = {}) {
  const parsed = normalizeError({ message }, tag, level);
  sinkConsole(parsed);
  await sinkChannel(parsed, channel);
  return parsed;
}

module.exports = {
  configure,
  reportError,
  log,
  normalizeError,
  formatForChannel,
  LEVELS,
};

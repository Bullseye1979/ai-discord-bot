// error.js — v2.0 (colored embeds for info/warn/error, console + optional channel)
// Usage examples:
//   await reportInfo(message.channel, "Connected", "VOICE");
//   await reportWarn(message.channel, "Rate limited, retrying …", "HTTP");
//   await reportError(err, message.channel, "CMD_JOINVC", { emit: "channel" });

const util = require("util");

// Discord brand-ish colors
const COLORS = {
  info: 0x57F287,   // green
  warn: 0xFAA61A,   // orange
  error: 0xED4245,  // red
};

// Redaction of secrets in strings
function redact(s) {
  try {
    let t = String(s ?? "");
    const patterns = [
      /Bearer\s+[A-Za-z0-9\-\._~\+\/]+=*/gi,
      /OPENAI_API_KEY\s*=\s*[A-Za-z0-9\-\._~]+/gi,
      /apikey\s*[:=]\s*["']?[A-Za-z0-9\-\._~]+["']?/gi,
      /authorization\s*[:=]\s*["']?Bearer\s+[A-Za-z0-9\-\._~\+\/]+=*["']?/gi,
      /password\s*[:=]\s*["'][^"']+["']/gi,
      /pass(word)?\b[^:\n]*:\s*[^,\n]+/gi,
    ];
    for (const re of patterns) t = t.replace(re, "[redacted]");
    return t;
  } catch {
    return String(s ?? "");
  }
}

function toShortString(obj, max = 1200) {
  try {
    if (obj instanceof Error) {
      const base = `${obj.name}: ${obj.message}\n${obj.stack || ""}`;
      const s = redact(base);
      return s.length > max ? s.slice(0, max) + "…" : s;
    }
    if (typeof obj === "string") {
      const s = redact(obj);
      return s.length > max ? s.slice(0, max) + "…" : s;
    }
    const s = redact(util.inspect(obj, { depth: 2, breakLength: 120 }));
    return s.length > max ? s.slice(0, max) + "…" : s;
  } catch {
    return String(obj ?? "");
  }
}

function buildEmbed({ level, tag, title, body, fields }) {
  const color =
    level === "info" ? COLORS.info :
    level === "warn" ? COLORS.warn :
    COLORS.error;

  const emoji =
    level === "info" ? "🟢" :
    level === "warn" ? "🟠" :
    "🔴";

  const safeTitle = title || `${emoji} ${tag || level.toUpperCase()}`;
  const embed = {
    color,
    title: safeTitle,
    description: body ? String(body) : undefined,
    timestamp: new Date().toISOString(),
  };

  if (Array.isArray(fields) && fields.length) {
    embed.fields = fields
      .filter(f => f && f.name && f.value)
      .slice(0, 20)
      .map(f => ({ name: String(f.name).slice(0, 256), value: String(f.value).slice(0, 1024) }));
  }

  return embed;
}

async function sendEmbed(channel, embed) {
  if (!channel) return;
  try {
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch {
    // Fallback to plain text if embeds fail
    const lines = [
      `**${embed.title || "Notice"}**`,
      embed.description || "",
      ...(embed.fields || []).map(f => `• **${f.name}:** ${f.value}`),
    ].filter(Boolean);
    try { await channel.send(lines.join("\n")); } catch {}
  }
}

/**
 * Report an INFO message (green embed)
 * @param {TextBasedChannel|null} channel
 * @param {string} text
 * @param {string} tag
 * @param {{emit?: 'channel'|'console'|'both', details?: any, title?: string}} opts
 */
async function reportInfo(channel, text, tag = "INFO", opts = {}) {
  const emit = opts.emit || (channel ? "both" : "console");
  const body = toShortString(text);

  if (emit === "console" || emit === "both") {
    // Keep console concise
    console.log(`[INFO][${tag}] ${body}`);
    if (opts.details) console.log(`[INFO][${tag}][details]`, toShortString(opts.details));
  }

  if ((emit === "channel" || emit === "both") && channel) {
    const fields = [];
    if (opts.details) fields.push({ name: "Details", value: "```" + toShortString(opts.details, 900) + "```" });
    const embed = buildEmbed({
      level: "info",
      tag,
      title: opts.title || null,
      body,
      fields,
    });
    await sendEmbed(channel, embed);
  }
}

/**
 * Report a WARNING (orange embed)
 * @param {TextBasedChannel|null} channel
 * @param {string} text
 * @param {string} tag
 * @param {{emit?: 'channel'|'console'|'both', details?: any, title?: string}} opts
 */
async function reportWarn(channel, text, tag = "WARN", opts = {}) {
  const emit = opts.emit || (channel ? "both" : "console");
  const body = toShortString(text);

  if (emit === "console" || emit === "both") {
    console.warn(`[WARN][${tag}] ${body}`);
    if (opts.details) console.warn(`[WARN][${tag}][details]`, toShortString(opts.details));
  }

  if ((emit === "channel" || emit === "both") && channel) {
    const fields = [];
    if (opts.details) fields.push({ name: "Details", value: "```" + toShortString(opts.details, 900) + "```" });
    const embed = buildEmbed({
      level: "warn",
      tag,
      title: opts.title || null,
      body,
      fields,
    });
    await sendEmbed(channel, embed);
  }
}

/**
 * Report an ERROR/FATAL (red embed)
 * @param {Error|string|any} err
 * @param {TextBasedChannel|null} channel
 * @param {string} tag
 * @param {{emit?: 'channel'|'console'|'both', fatal?: boolean, title?: string, details?: any}} opts
 */
async function reportError(err, channel, tag = "ERROR", opts = {}) {
  const emit = opts.emit || (channel ? "both" : "console");
  const isFatal = !!opts.fatal;

  const message = err instanceof Error ? err.message : (typeof err === "string" ? err : "");
  const stack = err instanceof Error ? err.stack : null;

  const body = toShortString(message || err);
  const details = opts.details || stack || null;

  if (emit === "console" || emit === "both") {
    const line = `[${isFatal ? "FATAL" : "ERROR"}][${tag}] ${body}`;
    isFatal ? console.error(line) : console.error(line);
    if (details) console.error(`[${isFatal ? "FATAL" : "ERROR"}][${tag}][details]`, toShortString(details));
  }

  if ((emit === "channel" || emit === "both") && channel) {
    const fields = [];
    if (details) fields.push({ name: isFatal ? "Stack/Details" : "Details", value: "```" + toShortString(details, 900) + "```" });

    const embed = buildEmbed({
      level: "error",
      tag: isFatal ? (tag || "FATAL") : tag,
      title: opts.title || null,
      body,
      fields,
    });

    await sendEmbed(channel, embed);
  }
}

module.exports = {
  reportInfo,
  reportWarn,
  reportError,
};

// error.js — v2.0
// Zentrale Meldungs-Funktion mit Leveln (INFO, WARN, ERROR, FATAL).
// Optionaler Channel-Output (embedfrei, chunk-sicher), kompakte Console-Log Ausgabe.

const LEVELS = ["INFO", "WARN", "ERROR", "FATAL"];
const ICON = { INFO: "ℹ️", WARN: "⚠️", ERROR: "❌", FATAL: "💥" };

// lazy import, um Zyklen zu vermeiden
function ensureHelper() {
  try {
    // Nur wenn wir in den Channel posten wollen:
    // sendChunked ist robust für 2000-char Limits
    // NICHT am Modul-Top importieren -> sonst Zirkularabhängigkeiten möglich.
    const { sendChunked } = require("./discord-helper.js");
    return { sendChunked };
  } catch {
    return { sendChunked: null };
  }
}

/** Baut eine kompakte Textzeile für den Channel. */
function formatForChannel(level, tag, text) {
  const L = LEVELS.includes(level) ? level : "INFO";
  const icon = ICON[L] || "";
  const t = tag ? `[${tag}]` : "";
  return `${icon} **${L}** ${t} ${text}`.trim();
}

/** Extrahiert aus Error/axios-Fehlern eine kurze Konsolenmeldung. */
function toConsoleLine(level, tag, errOrText) {
  const L = LEVELS.includes(level) ? level : "INFO";
  const base = tag ? `[${tag}]` : "";
  if (errOrText instanceof Error) {
    const msg = errOrText.message || String(errOrText);
    return `${L} ${base} ${msg}`;
  }
  if (typeof errOrText === "object") {
    try { return `${L} ${base} ${JSON.stringify(errOrText).slice(0, 1000)}`; }
    catch { return `${L} ${base} ${String(errOrText)}`; }
  }
  return `${L} ${base} ${String(errOrText)}`;
}

/**
 * Zentrale Reporting-Funktion.
 * @param {Error|string|object|null} err  - Fehlerobjekt ODER bereits formatierter Text (für INFO)
 * @param {object|null} channel           - Discord.js Channel-Objekt (optional)
 * @param {string|null} tag               - Kurzer Kontext (z.B. "CMD_JOINVC")
 * @param {("INFO"|"WARN"|"ERROR"|"FATAL")} level  - Standard: "ERROR"
 * @param {string|null} overrideText      - Wenn gesetzt, dieser Text wird in den Channel gepostet
 */
async function reportError(err, channel = null, tag = null, level = "ERROR", overrideText = null) {
  const L = LEVELS.includes(level) ? level : "ERROR";

  // 1) Console (kompakt, einmalig zentral)
  try {
    const line = toConsoleLine(L, tag, err ?? overrideText ?? "");
    // Eine schlanke Ausgabe reicht, stacktraces nur bei FATAL:
    if (L === "FATAL" && err && err.stack) {
      console.error(line, "\n", err.stack);
    } else if (L === "ERROR" || L === "WARN") {
      console.warn(line);
    } else {
      console.log(line);
    }
  } catch {}

  // 2) Optional in den Channel posten
  try {
    if (channel && typeof channel.send === "function") {
      const { sendChunked } = ensureHelper();
      const messageText =
        overrideText != null
          ? String(overrideText)
          : (err instanceof Error ? (err.message || String(err)) : String(err ?? ""));

      if (messageText && messageText.trim()) {
        const payload = formatForChannel(L, tag, messageText.trim());
        if (sendChunked) {
          await sendChunked(channel, payload);
        } else {
          await channel.send(payload);
        }
      }
    }
  } catch {
    // Channel-Fehler bei der Meldung werden still geschluckt, um Schleifen zu vermeiden.
  }
}

/** Bequeme Helfer für normale Channel-Ausgaben */
async function reportInfo(channel, text, tag = "INFO") {
  return reportError(text, channel, tag, "INFO");
}
async function reportWarn(channel, text, tag = "WARN") {
  return reportError(text, channel, tag, "WARN");
}
async function reportFatal(err, channel, tag = "FATAL") {
  return reportError(err, channel, tag, "FATAL");
}

module.exports = {
  reportError,
  reportInfo,
  reportWarn,
  reportFatal,
  LEVELS,
};

// error.js — v1.0
// Normalisiert Fehlerobjekte (inkl. Axios), redigiert sensible Header
// und postet optional eine kompakte, geparste Meldung in einen Discord-Channel.

const util = require("util");
const { sendChunked } = require("./discord-helper.js");

/** Interne Hilfe: Header redigieren (Authorization etc.) */
function redactHeaders(h = {}) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    const key = String(k).toLowerCase();
    if (key === "authorization" || key === "proxy-authorization") {
      out[k] = "Bearer ***";
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Fehler normalisieren (insb. Axios) */
function normalizeError(err, tag = "ERROR") {
  // Strings direkt kapseln
  if (typeof err === "string") {
    return { tag, message: err };
  }

  // Bereits serialisierte JSON-Fehler (z.B. aus aiService)
  if (err && typeof err.message === "string") {
    try {
      const parsed = JSON.parse(err.message);
      if (parsed && typeof parsed === "object" && (parsed.tag || parsed.status || parsed.data)) {
        return {
          tag: parsed.tag || tag,
          message: parsed.message || "",
          status: parsed.status ?? null,
          statusText: parsed.statusText ?? null,
          code: parsed.code ?? null,
          requestId: parsed.requestId ?? null,
          data: parsed.data ?? null,
        };
      }
    } catch {}
  }

  // Axios-Fehler roh
  const isAxios = !!(err && err.isAxiosError);
  const res = err?.response;
  const cfg = res?.config || err?.config;

  if (isAxios || res) {
    const rawData = res?.data;
    let data = rawData;

    // Daten kurz halten / in String konvertieren
    if (typeof rawData === "string") {
      data = rawData.slice(0, 2000);
    } else if (rawData && typeof rawData === "object") {
      try {
        const json = JSON.stringify(rawData);
        data = json.length > 2000 ? json.slice(0, 2000) + "…" : json;
      } catch {
        data = util.inspect(rawData, { depth: 1 }).slice(0, 2000);
      }
    }

    return {
      tag: err.tag || tag,
      message: err.message || (res?.statusText || "Request failed"),
      status: res?.status ?? null,
      statusText: res?.statusText ?? null,
      code: err?.code ?? null,
      requestId:
        res?.headers?.["x-request-id"] ||
        res?.headers?.["X-Request-ID"] ||
        null,
      config: cfg
        ? {
            method: cfg.method,
            url: cfg.url,
            headers: redactHeaders(cfg.headers),
          }
        : undefined,
      data,
    };
  }

  // Generischer Fehler
  return {
    tag: err?.tag || tag,
    message: err?.message || String(err),
    code: err?.code ?? null,
    // Stack NICHT standardmäßig in Channel posten – kann sensible Pfade enthalten
  };
}

/** Ausgabe für den Channel zusammenbauen (kurz & sicher) */
function formatErrorForChannel(parsed) {
  const lines = [];
  const push = (label, val) => {
    if (val === undefined || val === null || val === "") return;
    lines.push(`**${label}:** ${String(val)}`);
  };

  push("Tag", parsed.tag || "ERROR");
  push("Status", parsed.status != null ? `${parsed.status} ${parsed.statusText || ""}`.trim() : null);
  push("Code", parsed.code);
  push("Request-ID", parsed.requestId);
  push("Message", parsed.message);

  // Falls vorhanden, URL & Method zeigen (ohne Auth-Header)
  if (parsed.config?.url) {
    push("URL", parsed.config.url);
  }
  if (parsed.config?.method) {
    push("Method", String(parsed.config.method).toUpperCase());
  }

  // Daten anfügen, aber hart gekürzt
  if (parsed.data) {
    const preview = typeof parsed.data === "string" ? parsed.data : util.inspect(parsed.data, { depth: 1 });
    lines.push("\n**Response (preview):**");
    lines.push("```");
    lines.push(preview.slice(0, 1200));
    lines.push("```");
  }

  return `🚨 **Error Report**\n${lines.join("\n")}`;
}

/**
 * Hauptfunktion: Fehler parsen und optional im Channel posten.
 * @param {any} err - beliebiges Error-Objekt/String
 * @param {object} [channel] - Discord TextChannel (oder Thread), optional
 * @param {string} [tag] - optionales Tag/Label
 * @returns {object} parsed - das normalisierte Fehlerobjekt
 */
async function reportError(err, channel, tag = "ERROR") {
  const parsed = normalizeError(err, tag);
  if (channel && typeof channel.send === "function") {
    try {
      const text = formatErrorForChannel(parsed);
      await sendChunked(channel, text);
    } catch (e) {
      // Fallback: minimal posten
      try { await channel.send("🚨 Error (posting failed). Check logs."); } catch {}
    }
  }
  return parsed;
}

module.exports = { reportError, normalizeError, formatErrorForChannel };

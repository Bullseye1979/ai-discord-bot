// helper.js — refactored v1.1
// Kleine Hilfsfunktionen: URL-Shortener, sicheres Löschen, HTML → Plaintext.
// Alle Fehler-/Hinweis-Ausgaben laufen über reportError (Level: INFO, WARN, ERROR, FATAL).

const axios = require("axios");
const fs = require("fs/promises");
const { reportError } = require("./error.js");

/**
 * Kürzt eine URL via tinyurl.com.
 * Fallback: gibt bei Fehlern die ursprüngliche URL zurück.
 */
async function getShortURL(longUrl, channel = null) {
  try {
    const res = await axios.get(
      `https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`,
      { timeout: 15000 }
    );
    const short = String(res?.data || "").trim();
    if (!short) throw new Error("Empty response from TinyURL");
    return short;
  } catch (err) {
    // Nur Hinweis – funktional weiter mit Original-URL
    await reportError(err, channel, "GET_SHORT_URL", "WARN", { longUrl });
    return longUrl;
  }
}

/**
 * Löscht eine Datei best-effort.
 * - ENOENT wird als INFO geloggt (Datei existiert bereits nicht)
 * - andere Fehler als WARN
 */
async function getSafeDelete(filePath, channel = null) {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    const level = err?.code === "ENOENT" ? "INFO" : "WARN";
    await reportError(err, channel, "SAFE_DELETE", level, { filePath });
  }
}

/**
 * Entfernt HTML-Tags und schneidet auf maxLength.
 */
function getPlainFromHTML(input, maxLength = 2000) {
  if (!input) return "";
  try {
    const withoutHTML = String(input).replace(/<[^>]*>?/gm, "");
    return withoutHTML.slice(0, maxLength);
  } catch (err) {
    // Sollte praktisch nie passieren – defensiv als WARN loggen, leer zurückgeben
    reportError(err, null, "PLAIN_FROM_HTML", "WARN", { maxLength });
    return "";
  }
}

module.exports = { getShortURL, getSafeDelete, getPlainFromHTML };

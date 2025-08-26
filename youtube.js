// youtube.js
// Version: 2.0 (uses youtube-transcript-plus)
// Get the subtitles from YouTube videos and process them with AI

const { YoutubeTranscript } = require('youtube-transcript-plus');
const { getAI } = require('./aiService.js');
const Context = require('./context');

const MAX_TOKENS_PER_CHUNK = 2000;

// --- Helpers ---------------------------------------------------------

// robust: holt die ID aus watch/shorts/embed/short-URL – oder nimmt den String als ID
function extractVideoId(input) {
  try {
    if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
    const u = new URL(input);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1);
    if (u.pathname.startsWith('/watch')) return u.searchParams.get('v');
    if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2] || null;
    if (u.pathname.startsWith('/embed/')) return u.pathname.split('/')[2] || null;
    return u.searchParams.get('v');
  } catch {
    return /^[A-Za-z0-9_-]{11}$/.test(input) ? input : null;
  }
}

// Das Paket liefert Objekte { text, duration, offset }.
// Manche Implementationen liefern offset in Sekunden, manche in Millisekunden.
// Diese Funktion normalisiert auf Sekunden.
function toSeconds(offset) {
  if (offset == null) return 0;
  const n = Number(offset);
  // Heuristik: > 10h → wahrscheinlich Millisekunden
  return n > 36000 ? n / 1000 : n;
}

function getTimestamp(seconds) {
  const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// Formt die Transcript-Items in unser internes Format ({ start, text }) um
function normalizeTranscript(items) {
  return (items || []).map(it => ({
    start: toSeconds(it.offset ?? it.start ?? 0),
    text: String(it.text || '').trim(),
  })).filter(x => x.text);
}

// Chunks anhand „ungefähren Tokens“ (Wörter) bilden
function getChunks(transcript, maxTokensPerChunk) {
  const chunks = [];
  let cur = { timestamp: null, text: '', tokenCount: 0 };

  for (const entry of transcript) {
    const tokenCount = entry.text.split(/\s+/).length;
    if (!cur.timestamp) cur.timestamp = getTimestamp(entry.start);
    if (cur.tokenCount + tokenCount > maxTokensPerChunk) {
      chunks.push(cur);
      cur = { timestamp: getTimestamp(entry.start), text: entry.text, tokenCount };
    } else {
      cur.text += (cur.text ? ' ' : '') + entry.text;
      cur.tokenCount += tokenCount;
    }
  }
  if (cur.text) chunks.push(cur);
  return chunks;
}

// Holt Transkript (versucht mehrere Sprachen inkl. auto)
async function fetchTranscript(videoId) {
  const langCandidates = ['de', 'a.de', 'en', 'a.en', 'en-US', 'en-GB'];
  for (const lang of langCandidates) {
    try {
      const items = await YoutubeTranscript.fetchTranscript(videoId, { lang });
      if (Array.isArray(items) && items.length) return normalizeTranscript(items);
    } catch (_) {
      // weiterprobieren
    }
  }
  // Letzter Versuch: ohne Sprachangabe (Bibliothek wählt "beste" Spur)
  try {
    const items = await YoutubeTranscript.fetchTranscript(videoId);
    if (Array.isArray(items) && items.length) return normalizeTranscript(items);
  } catch (_) {}
  return [];
}

// --- Tool-Entry ------------------------------------------------------

async function getYoutube(toolFunction) {
  try {
    const args = JSON.parse(toolFunction.arguments || '{}');
    const userPrompt = String(args.user_prompt || '');
    const videoUrl = String(args.video_url || '');
    const videoId = extractVideoId(videoUrl);

    if (!videoId) {
      return '[Error] Unable to extract YouTube video ID.';
    }

    const transcript = await fetchTranscript(videoId);
    if (!transcript.length) {
      return '[Error] No transcript found for this video.';
    }

    // Frischer, temporärer In-Memory-Kontext für die Analyse
    const analysisContext = new Context(); // nutzt deinen Standard-Context
    const chunks = getChunks(transcript, MAX_TOKENS_PER_CHUNK);

    const results = [];
    for (const { timestamp, text } of chunks) {
      await analysisContext.add(
        'user',
        'instruction',
        `Based on the user's request: "${userPrompt}", summarize or condense the current section (${timestamp}): ${text} in the context of the entire conversation so far. Be concise, cumulative and structured.`
      );

      // Model & Token-Limit wie gehabt (du kannst es hier natürlich anpassen)
      const result = await getAI(analysisContext, 100, 'gpt-3.5-turbo');
      if (result) {
        results.push(`[${timestamp}] ${result}`);
        await analysisContext.add('assistant', 'gpt', result);
      }
    }

    return results.join('\n');
  } catch (error) {
    console.error('[getYoutube ERROR]:', error?.message || error);
    return '[Error] Unable to process the video.';
  }
}

module.exports = { getYoutube };

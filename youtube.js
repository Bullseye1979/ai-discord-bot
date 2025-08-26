const { getSubtitles, getTranscript } = require("youtube-captions-scraper");
const { getAI } = require("./aiService.js");
const Context = require("./context");

const MAX_TOKENS_PER_CHUNK = 2000;

// robust: holt die ID aus watch/shorts/embed/short-URL – oder nimmt den String als ID
function extractVideoId(input) {
  try {
    // Falls schon eine reine ID (11 Zeichen, grob)
    if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;

    const u = new URL(input);
    if (u.hostname === "youtu.be") return u.pathname.slice(1);
    if (u.pathname.startsWith("/watch")) return u.searchParams.get("v");
    if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2] || null;
    if (u.pathname.startsWith("/embed/")) return u.pathname.split("/")[2] || null;
    return u.searchParams.get("v"); // letzter Versuch
  } catch {
    // Fallback: vielleicht wurde wirklich nur die ID übergeben
    return /^[A-Za-z0-9_-]{11}$/.test(input) ? input : null;
  }
}

async function getYoutube(toolFunction) {
  try {
    const args = JSON.parse(toolFunction.arguments || "{}");
    const userPrompt = args.user_prompt || "";
    const videoUrl = String(args.video_url || "");
    const videoId = extractVideoId(videoUrl);

    if (!videoId) {
      return "[Error] Unable to extract YouTube video ID.";
    }

    // 1) Versuche mehrere Sprach-Codes inkl. auto-generated
    const langCandidates = ["en", "a.en", "en-US", "en-GB", "de", "a.de"];
    let transcript = [];

    for (const lang of langCandidates) {
      try {
        const t = await getSubtitles({ videoID: videoId, lang });
        if (Array.isArray(t) && t.length) { transcript = t; break; }
      } catch { /* still try others */ }
    }

    // 2) Optionaler Fallback: library-API ohne Sprache (holt „beste“ Spur)
    if ((!transcript || transcript.length === 0) && typeof getTranscript === "function") {
      try {
        const t = await getTranscript(videoId);
        if (Array.isArray(t) && t.length) transcript = t;
      } catch { /* ignore */ }
    }

    if (!transcript || transcript.length === 0) {
      return "[Error] No transcript found for this video.";
    }

    // 3) Chunks bilden & mit einem frischen Memory-only Context pro Run verarbeiten
    const textChunks = getChunks(transcript, MAX_TOKENS_PER_CHUNK);
    const results = [];
    const analysisContext = new Context(); // memory-only, keine DB

    for (const { timestamp, text } of textChunks) {
      await analysisContext.add(
        "user",
        "instruction",
        `Based on the user's request: "${userPrompt}", summarize or condense the current section (${timestamp}): ${text} in the context of the entire conversation so far. Be concise, cumulative and structured.`
      );

      const result = await getAI(analysisContext, 100, "gpt-3.5-turbo");
      if (result) {
        results.push(`[${timestamp}] ${result}`);
        await analysisContext.add("assistant", "gpt", result);
      }
    }

    return results.join("\n");
  } catch (error) {
    console.error("[getYoutube ERROR]:", error?.message || error);
    return "[Error] Unable to process the video.";
  }
}

// unverändert
function getChunks(transcript, maxTokensPerChunk) {
  const chunks = [];
  let cur = { timestamp: null, text: "", tokenCount: 0 };
  for (const entry of transcript) {
    const tokenCount = entry.text.split(/\s+/).length;
    if (!cur.timestamp) cur.timestamp = getTimestamp(entry.start);
    if (cur.tokenCount + tokenCount > maxTokensPerChunk) {
      chunks.push(cur);
      cur = { timestamp: getTimestamp(entry.start), text: entry.text, tokenCount };
    } else {
      cur.text += (cur.text ? " " : "") + entry.text;
      cur.tokenCount += tokenCount;
    }
  }
  if (cur.text) chunks.push(cur);
  return chunks;
}

function getTimestamp(seconds) {
  const h = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

module.exports = { getYoutube };

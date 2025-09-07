// youtube.js — v3.0 (no-chunk, GPT-4.1 large-context summarization)
// Summarize a YouTube video's transcript (CC) in ONE pass using GPT-4.1.
// We fetch the CCs, assemble them into a single timeline text, and summarize directly.

const { getAI } = require("./aiService.js");
const Context = require("./context.js");

const MAX_INPUT_CHARS = 250_000;  // safety cap for transcript text
const YT_SUMMARY_MODEL = "gpt-4.1";
const YT_SUMMARY_TOKENS = 1400;

let _YT;
async function loadYT() {
  if (_YT) return _YT;
  const m = await import("youtube-transcript-plus");
  _YT = m.YoutubeTranscript || m.default?.YoutubeTranscript || m.default;
  return _YT;
}

/** Extracts a YouTube video ID from various URL formats or plain IDs. */
function extractVideoId(input) {
  try {
    if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
    const u = new URL(input);
    if (u.hostname === "youtu.be") return u.pathname.slice(1);
    if (u.pathname.startsWith("/watch")) return u.searchParams.get("v");
    if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2] || null;
    if (u.pathname.startsWith("/embed/")) return u.pathname.split("/")[2] || null;
    return u.searchParams.get("v");
  } catch {
    return /^[A-Za-z0-9_-]{11}$/.test(input) ? input : null;
  }
}

/** Converts offset to seconds (accepts seconds or ms). */
function toSeconds(offset) {
  const n = Number(offset || 0);
  return n > 10000 ? Math.round(n / 1000) : Math.round(n);
}

/** Formats seconds to mm:ss or hh:mm:ss. */
function fmtTime(s) {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (x) => String(x).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Normalizes raw transcript items into {start, text}. */
function normalizeTranscript(items) {
  return (items || [])
    .map((it) => ({
      start: toSeconds(it.offset ?? it.start ?? 0),
      text: String(it.text || "").trim(),
    }))
    .filter((x) => x.text);
}

/** Fetches transcript in preferred languages with fallbacks. */
async function fetchTranscript(videoId) {
  const YoutubeTranscript = await loadYT();
  const langs = ["de", "a.de", "en", "a.en", "en-US", "en-GB"];
  for (const lang of langs) {
    try {
      const items = await YoutubeTranscript.fetchTranscript(videoId, { lang });
      if (Array.isArray(items) && items.length) return normalizeTranscript(items);
    } catch {} // try next language
  }
  try {
    const items = await YoutubeTranscript.fetchTranscript(videoId);
    if (Array.isArray(items) && items.length) return normalizeTranscript(items);
  } catch {}
  return [];
}

/** Tool entry: summarize a YouTube transcript in a single pass guided by the user's prompt. */
async function getYoutube(toolFunction) {
  try {
    const args =
      typeof toolFunction.arguments === "string"
        ? JSON.parse(toolFunction.arguments || "{}")
        : (toolFunction.arguments || {});

    const userPrompt = String(args.user_prompt || "").trim();
    const videoUrl = String(args.video_url || "").trim();
    const videoId = extractVideoId(videoUrl);

    if (!videoId) return "[ERROR]: YT_BAD_ID — Unable to extract a valid YouTube video ID.";
    if (!userPrompt) return "[ERROR]: YT_NO_PROMPT — Missing 'user_prompt' to guide the summary.";

    const transcript = await fetchTranscript(videoId);
    if (!transcript.length) return "[ERROR]: YT_NO_TRANSCRIPT — No transcript available for this video.";

    // Assemble a single timeline text like:
    // [0:05] Intro text...
    // [0:47] Next line...
    let timeline = "";
    for (const entry of transcript) {
      timeline += `[${fmtTime(entry.start)}] ${entry.text}\n`;
      if (timeline.length > MAX_INPUT_CHARS) break; // safety cap
    }

    const ctx = new Context();
    await ctx.add(
      "system",
      "summarizer",
      [
        "You are a meticulous summarizer with a very large context window.",
        "Summarize the following YouTube transcript with minimal information loss.",
        "Preserve key names, figures, timestamps when relevant, and important numbers.",
        "Use compact, well-structured output (headings and bullet points where useful).",
        "Write in the user's language if inferable (German if unsure).",
      ].join(" ")
    );

    await ctx.add("user", "request", `User request: "${userPrompt}".`);
    await ctx.add("user", "transcript", timeline);

    const out = await getAI(ctx, YT_SUMMARY_TOKENS, YT_SUMMARY_MODEL);
    return (out || "").trim() || "[ERROR]: YT_SUMMARY_EMPTY — No summary returned.";
  } catch (err) {
    const msg = err?.message || "unexpected error";
    return `[ERROR]: YT_FAILURE — ${msg}`;
  }
}

module.exports = { getYoutube };

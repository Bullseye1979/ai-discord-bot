// youtube.js — clean v2.1 (CJS)
// Summarize a YouTube video's transcript in time-stamped chunks based on a user prompt.

const { getAI } = require("./aiService.js");
const Context = require("./context.js");

const MAX_TOKENS_PER_CHUNK = 2000;

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
  const n = Number(offset ?? 0);
  return n > 36000 ? n / 1000 : n;
}

/** Formats seconds as HH:MM:SS. */
function fmtTime(seconds) {
  const h = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
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

/** Splits transcript into chunks near a token budget (simple word-count heuristic). */
function chunkTranscript(transcript, maxTokens) {
  const chunks = [];
  let cur = { timestamp: null, text: "", tokens: 0 };
  for (const entry of transcript) {
    const tks = entry.text.split(/\s+/).length;
    if (!cur.timestamp) cur.timestamp = fmtTime(entry.start);
    if (cur.tokens + tks > maxTokens) {
      if (cur.text) chunks.push(cur);
      cur = { timestamp: fmtTime(entry.start), text: entry.text, tokens: tks };
    } else {
      cur.text += (cur.text ? " " : "") + entry.text;
      cur.tokens += tks;
    }
  }
  if (cur.text) chunks.push(cur);
  return chunks;
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

/** Tool entry: summarize a YouTube transcript in chunks guided by the user's prompt. */
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

    const chunks = chunkTranscript(transcript, MAX_TOKENS_PER_CHUNK);
    const ctx = new Context();
    const results = [];

    for (const { timestamp, text } of chunks) {
      await ctx.add(
        "user",
        "instruction",
        `User request: "${userPrompt}". Summarize the current section (${timestamp}) concisely and cumulatively. Keep key facts, names, and numbers.`
      );
      await ctx.add("user", "section", text);
      const out = await getAI(ctx, 120, "gpt-4o-mini");
      if (out) {
        results.push(`[${timestamp}] ${out.trim()}`);
        await ctx.add("assistant", "summary", out.trim());
      }
    }

    return results.join("\n");
  } catch (err) {
    const msg = err?.message || "unexpected error";
    return `[ERROR]: YT_FAILURE — ${msg}`;
  }
}

module.exports = { getYoutube };

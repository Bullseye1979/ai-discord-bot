// youtube.js — v3.1 (generic transcript Q&A via GPT-4.1)
// Fetch YouTube transcript (CCs), feed into GPT-4.1 with user prompt, return result.
// Not forced to summarize anymore — the user_prompt defines what should happen.

const { getAI } = require("./aiService.js");
const Context = require("./context.js");

const MAX_INPUT_CHARS = 250_000;  // safety cap
const YT_MODEL = "gpt-4.1";
const YT_TOKENS = 1400;

let _YT;
async function loadYT() {
  if (_YT) return _YT;
  const m = await import("youtube-transcript-plus");
  _YT = m.YoutubeTranscript || m.default?.YoutubeTranscript || m.default;
  return _YT;
}

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

function toSeconds(offset) {
  const n = Number(offset || 0);
  return n > 10000 ? Math.round(n / 1000) : Math.round(n);
}

function fmtTime(s) {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (x) => String(x).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function normalizeTranscript(items) {
  return (items || [])
    .map((it) => ({
      start: toSeconds(it.offset ?? it.start ?? 0),
      text: String(it.text || "").trim(),
    }))
    .filter((x) => x.text);
}

async function fetchTranscript(videoId) {
  const YoutubeTranscript = await loadYT();
  const langs = ["de", "a.de", "en", "a.en", "en-US", "en-GB"];
  for (const lang of langs) {
    try {
      const items = await YoutubeTranscript.fetchTranscript(videoId, { lang });
      if (Array.isArray(items) && items.length) return normalizeTranscript(items);
    } catch {}
  }
  try {
    const items = await YoutubeTranscript.fetchTranscript(videoId);
    if (Array.isArray(items) && items.length) return normalizeTranscript(items);
  } catch {}
  return [];
}

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
    if (!userPrompt) return "[ERROR]: YT_NO_PROMPT — Missing 'user_prompt'.";

    const transcript = await fetchTranscript(videoId);
    if (!transcript.length) return "[ERROR]: YT_NO_TRANSCRIPT — No transcript available for this video.";

    // Build timeline text
    let timeline = "";
    for (const entry of transcript) {
      timeline += `[${fmtTime(entry.start)}] ${entry.text}\n`;
      if (timeline.length > MAX_INPUT_CHARS) break;
    }

    const ctx = new Context();
    await ctx.add(
      "system",
      "yt_analyst",
      [
        "You are a helpful assistant with a very large context window.",
        "You are given a YouTube transcript with timestamps.",
        "Answer the user's request precisely, using the transcript as source.",
        "Preserve names, numbers, and timestamps where they matter.",
        "Output should directly address the request (can be summary, quotes, analysis, etc.).",
      ].join(" ")
    );

    await ctx.add("user", "request", `User request: "${userPrompt}"`);
    await ctx.add("user", "transcript", timeline);

    const out = await getAI(ctx, YT_TOKENS, YT_MODEL);
    return (out || "").trim() || "[ERROR]: YT_EMPTY_OUTPUT — No result returned.";
  } catch (err) {
    const msg = err?.message || "unexpected error";
    return `[ERROR]: YT_FAILURE — ${msg}`;
  }
}

module.exports = { getYoutube };

// youtube.js — v4.0 (transcript QA + metadata + topic search)
// - getYoutube: Executes user_prompt against a YouTube transcript; ALSO returns metadata (title, channel, publishedAt)
// - getYoutubeSearch: Topic search via YouTube Data API v3 (no transcript), returns compact results
// Returns for getYoutube: { result, video_url, meta: { title, channel_title, published_at, video_id, channel_id } }

const axios = require("axios");
const { getAI } = require("./aiService.js");
const Context = require("./context.js");

const MAX_INPUT_CHARS = 250_000;
const YT_MODEL = "gpt-4.1";
const YT_TOKENS = 1400;

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "";

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
  const langs = ["de", "a.de", "de-DE", "en", "a.en", "en-US", "en-GB"];
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

// ---- YouTube Data API helpers ----------------------------------------------

async function fetchVideoMeta(videoId) {
  if (!GOOGLE_API_KEY) {
    return { error: "YT_NO_API_KEY — Missing GOOGLE_API_KEY in environment." };
  }
  try {
    const url = "https://www.googleapis.com/youtube/v3/videos";
    const params = {
      key: GOOGLE_API_KEY,
      id: videoId,
      part: "snippet",
      maxWidth: 1
    };
    const { data } = await axios.get(url, { params, timeout: 15000 });
    const item = data?.items?.[0];
    if (!item?.snippet) {
      return { error: "YT_META_NOT_FOUND — Video metadata not found." };
    }
    const sn = item.snippet;
    return {
      video_id: videoId,
      title: sn.title || "",
      channel_title: sn.channelTitle || "",
      channel_id: sn.channelId || "",
      published_at: sn.publishedAt || ""
    };
  } catch (err) {
    return { error: `YT_META_FAILURE — ${err?.response?.status || ""} ${err?.message || "Request failed"}` };
  }
}

async function searchVideos({
  query,
  maxResults = 5,
  relevanceLanguage = "de",
  regionCode = "DE",
  safeSearch = "none"
}) {
  if (!GOOGLE_API_KEY) {
    return { error: "YT_NO_API_KEY — Missing GOOGLE_API_KEY in environment." };
  }
  try {
    const url = "https://www.googleapis.com/youtube/v3/search";
    const params = {
      key: GOOGLE_API_KEY,
      part: "snippet",
      type: "video",
      q: query,
      maxResults: Math.max(1, Math.min(Number(maxResults) || 5, 10)),
      relevanceLanguage,
      regionCode,
      safeSearch // "none" | "moderate" | "strict"
    };
    const { data } = await axios.get(url, { params, timeout: 15000 });

    const results = (data?.items || []).map((it) => {
      const id = it?.id?.videoId || "";
      const sn = it?.snippet || {};
      return {
        video_id: id,
        video_url: id ? `https://www.youtube.com/watch?v=${id}` : "",
        title: sn.title || "",
        channel_title: sn.channelTitle || "",
        channel_id: sn.channelId || "",
        published_at: sn.publishedAt || "",
        description: (sn.description || "").slice(0, 400)
      };
    });

    return { results };
  } catch (err) {
    return { error: `YT_SEARCH_FAILURE — ${err?.response?.status || ""} ${err?.message || "Request failed"}` };
  }
}

// ---- Tool functions ---------------------------------------------------------

async function getYoutube(toolFunction) {
  try {
    const args =
      typeof toolFunction.arguments === "string"
        ? JSON.parse(toolFunction.arguments || "{}")
        : (toolFunction.arguments || {});

    const userPrompt = String(args.user_prompt || "").trim();
    const videoUrl = String(args.video_url || "").trim();
    const videoId = extractVideoId(videoUrl);

    if (!videoId) return JSON.stringify({ error: "YT_BAD_ID — Invalid video ID/URL." });
    if (!userPrompt) return JSON.stringify({ error: "YT_NO_PROMPT — Missing 'user_prompt'." });

    const [transcript, meta] = await Promise.all([
      fetchTranscript(videoId),
      fetchVideoMeta(videoId)
    ]);

    if (!transcript.length) return JSON.stringify({ error: "YT_NO_TRANSCRIPT — No transcript available." });
    if (meta?.error && GOOGLE_API_KEY) {
      // Metadaten sind optional für die Analyse; wir geben den Fehler aber zurück.
      // (Wenn kein Key vorhanden ist, liefern wir einfach kein meta-Objekt.)
    }

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
        "Preserve key names, numbers, and timestamps where relevant."
      ].join(" ")
    );
    await ctx.add("user", "request", `User request: "${userPrompt}"`);
    await ctx.add("user", "transcript", timeline);

    const out = await getAI(ctx, YT_TOKENS, YT_MODEL);

    const payload = {
      result: (out || "").trim(),
      video_url: videoUrl
    };

    // Meta nur anhängen, wenn vorhanden
    if (meta && !meta.error) {
      payload.meta = {
        title: meta.title,
        channel_title: meta.channel_title,
        published_at: meta.published_at,
        video_id: meta.video_id,
        channel_id: meta.channel_id
      };
    } else if (!GOOGLE_API_KEY) {
      payload.meta = { warning: "No GOOGLE_API_KEY configured: metadata omitted." };
    } else if (meta?.error) {
      payload.meta = { error: meta.error };
    }

    return JSON.stringify(payload);
  } catch (err) {
    return JSON.stringify({ error: `YT_FAILURE — ${err?.message || "Unexpected error"}` });
  }
}

async function getYoutubeSearch(toolFunction) {
  try {
    const args =
      typeof toolFunction.arguments === "string"
        ? JSON.parse(toolFunction.arguments || "{}")
        : (toolFunction.arguments || {});

    const query = String(args.query || args.user_prompt || "").trim();
    const maxResults = args.max_results ?? 5;
    const relevanceLanguage = String(args.relevance_language || "de").trim();
    const regionCode = String(args.region_code || "DE").trim();
    const safeSearch = String(args.safe_search || "none").trim();

    if (!query) return JSON.stringify({ error: "YT_SEARCH_NO_QUERY — Missing 'query'." });

    const res = await searchVideos({ query, maxResults, relevanceLanguage, regionCode, safeSearch });
    if (res?.error) return JSON.stringify({ error: res.error });

    return JSON.stringify({
      results: res.results || [],
      query,
      params: { max_results: maxResults, relevance_language: relevanceLanguage, region_code: regionCode, safe_search: safeSearch }
    });
  } catch (err) {
    return JSON.stringify({ error: `YT_SEARCH_FAILURE — ${err?.message || "Unexpected error"}` });
  }
}

module.exports = { getYoutube, getYoutubeSearch };

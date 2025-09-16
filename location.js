// location.js — v2.7 (GOOGLE_API_KEY; server-side download of Static Street View image)
// Build Google Maps (route/search) links via api=1, optional Street View (pano link),
// plus human-readable driving directions via Directions API.
// NEW: Static Street View image wird SERVERSEITIG heruntergeladen, lokal gespeichert
//      und als dauerhafte URL wie in getImage zurückgegeben.
// NOTE: Keine Static Map (Routenbild).
// ENV: GOOGLE_API_KEY, PUBLIC_BASE_URL (optional), BASE_URL (Fallback)

const axios = require("axios");
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// ——— Ablageort & URL-Format exakt wie in getImage ———
const PICTURES_DIR = path.join(__dirname, "documents", "pictures");

function ensureAbsoluteUrl(urlPath) {
  const base = (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "").replace(/\/$/, "");
  if (/^https?:\/\//i.test(urlPath)) return urlPath;
  if (base) return `${base}${urlPath.startsWith("/") ? "" : "/"}${urlPath}`;
  return urlPath; // relativ als Fallback
}

function pickExtFromContentType(ct) {
  const s = String(ct || "").toLowerCase();
  if (s.includes("image/png")) return ".png";
  if (s.includes("image/jpeg") || s.includes("image/jpg")) return ".jpg";
  if (s.includes("image/webp")) return ".webp";
  if (s.includes("image/gif")) return ".gif";
  return ".png"; // default
}

function safeBaseFromHint(hint) {
  const s = String(hint || "streetview")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return s || "streetview";
}

async function saveBufferAsPicture(buffer, nameHint, contentTypeHint = "image/png") {
  await fs.mkdir(PICTURES_DIR, { recursive: true });
  const ext = pickExtFromContentType(contentTypeHint);
  const slug = safeBaseFromHint(nameHint);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(4).toString("hex");
  const filename = `${slug}-${ts}-${rand}${ext}`;
  const filePath = path.join(PICTURES_DIR, filename);
  await fs.writeFile(filePath, buffer);
  const publicUrl = ensureAbsoluteUrl(`/documents/pictures/${filename}`);
  return { filename, filePath, publicUrl };
}

/** Detect "lat,lon" input. */
function isLatLon(input) {
  return /^\s*-?\d{1,2}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*$/.test(String(input || ""));
}

/** Normalize free-text address. */
function normalize(s) {
  return String(s || "")
    .trim()
    .replace(/^[,;]+|[,;]+$/g, "")
    .replace(/\s{2,}/g, " ");
}

/** Trim coordinate precision to reduce URL length (5–6 decimals ~ cm-meter precision). */
function trimLatLng(lat, lng, decimals = 5) {
  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const la = toNum(lat);
  const ln = toNum(lng);
  if (la === null || ln === null) return null;
  return `${la.toFixed(decimals)},${ln.toFixed(decimals)}`;
}

/** Geocode one query into { coord, address, plusCode } or null. */
async function geocodeOne(query, { language = "en", region = "de" } = {}) {
  const q = normalize(query);
  if (!q) return null;

  if (isLatLon(q)) {
    const [lat, lng] = q.split(",").map((x) => x.trim());
    const trimmed = trimLatLng(lat, lng) || `${lat},${lng}`;
    return { coord: trimmed, address: q, plusCode: null };
  }

  try {
    const resp = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: { address: q, key: GOOGLE_API_KEY, language, region },
      timeout: 20000,
    });
    const { status, results, error_message } = resp.data || {};
    if (status !== "OK" || !Array.isArray(results) || !results.length) {
      console.error("[getLocation][geocode] status:", status, "msg:", error_message, "q:", q);
      return null;
    }
    const r0 = results[0];
    const lat = r0?.geometry?.location?.lat;
    const lng = r0?.geometry?.location?.lng;
    const trimmed = trimLatLng(lat, lng);
    const plusCode =
      r0?.plus_code?.global_code ||
      r0?.plus_code?.compound_code ||
      null;

    if (!trimmed) return null;
    return { coord: trimmed, address: r0?.formatted_address || q, plusCode };
  } catch (e) {
    console.error("[getLocation][geocode] error:", e?.response?.data || e?.message || e);
    return null;
  }
}

/** Build Maps URL using api=1 (shorter & robust).
 * For route: https://www.google.com/maps/dir/?api=1&origin=...&destination=...&waypoints=...
 * For search: https://www.google.com/maps/search/?api=1&query=...
 */
function buildMapsURLApi1({ points, isRoute, language = "en" }) {
  const hl = encodeURIComponent(language || "en");

  if (isRoute) {
    const origin = encodeURIComponent(points[0]);
    const destination = encodeURIComponent(points[points.length - 1]);
    const waypoints = points.slice(1, -1);
    const wp = waypoints.length ? `&waypoints=${encodeURIComponent(waypoints.join("|"))}` : "";
    // travelmode=driving to match Directions text
    return `https://www.google.com/maps/dir/?api=1&hl=${hl}&origin=${origin}&destination=${destination}${wp}&travelmode=driving`;
  }

  // search: use the last point as the query
  const query = encodeURIComponent(points[points.length - 1]);
  return `https://www.google.com/maps/search/?api=1&hl=${hl}&query=${query}`;
}

/** Build Street View (pano) URL using api=1 (no API key exposure). */
function buildStreetViewPanoURL(latLon, language = "en") {
  const hl = encodeURIComponent(language || "en");
  return `https://www.google.com/maps/@?api=1&hl=${hl}&map_action=pano&viewpoint=${encodeURIComponent(latLon)}`;
}

/** Build Street View Static Image URL (server will download it). */
function buildStreetViewImageURL(latLon, { size = "640x400", fov = 90, heading, pitch } = {}) {
  const params = new URLSearchParams({
    size,
    location: latLon,
    key: GOOGLE_API_KEY,
    fov: String(fov),
  });
  if (heading !== undefined) params.set("heading", String(heading));
  if (pitch !== undefined) params.set("pitch", String(pitch));
  return `https://maps.googleapis.com/maps/api/streetview?${params.toString()}`;
}

/** Optional: Street View Metadata check to vermeiden leerer Bilder. */
async function hasStreetView(latLon) {
  try {
    const url = "https://maps.googleapis.com/maps/api/streetview/metadata";
    const params = { location: latLon, key: GOOGLE_API_KEY };
    const { data } = await axios.get(url, { params, timeout: 10000 });
    return { ok: data?.status === "OK", status: data?.status || "UNKNOWN" };
  } catch (e) {
    console.error("[getLocation][sv-metadata] error:", e?.response?.data || e?.message || e);
    return { ok: false, status: "ERROR" };
  }
}

/** Download Street View image to local pictures dir; return { url, file }. */
async function downloadStreetViewToLocal(imageUrl, nameHint) {
  const res = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 30000 });
  const buf = Buffer.from(res.data);
  const ct = res.headers?.["content-type"] || "image/png";
  const saved = await saveBufferAsPicture(buf, nameHint, ct);
  return {
    url: saved.publicUrl,                           // wie getImage.url
    file: `/documents/pictures/${saved.filename}`   // wie getImage.file (relativ)
  };
}

/** Get directions text (route). */
async function getDirectionsText(origin, destination, waypoints = [], language = "en") {
  try {
    const params = {
      origin,
      destination,
      mode: "driving",
      key: GOOGLE_API_KEY,
      language,
    };
    if (waypoints.length) params.waypoints = waypoints.join("|");

    const resp = await axios.get("https://maps.googleapis.com/maps/api/directions/json", {
      params,
      timeout: 20000,
    });
    const { status, routes, error_message } = resp.data || {};
    if (status !== "OK" || !routes?.length) {
      console.error("[getLocation][directions] status:", status, "msg:", error_message);
      const hint =
        status === "REQUEST_DENIED"
          ? "Directions API not enabled or key restricted."
          : status || "No directions found.";
      return `No directions found. (${hint})`;
    }

    const steps = routes[0].legs.flatMap((leg) => leg.steps.map((s) => s.html_instructions));
    const textSteps = steps.map((s, i) => `${i + 1}. ${String(s || "").replace(/<[^>]+>/g, "")}`);
    return textSteps.join("\n");
  } catch (e) {
    console.error("[getLocation][directions] error:", e?.response?.data || e?.message || e);
    return "No directions found. (Unexpected error)";
  }
}

/** Tool entry: return Street View links & LOCAL image URL, Maps link, and directions (if route). */
async function getLocation(toolFunction) {
  try {
    if (!GOOGLE_API_KEY) {
      console.error("getLocation: Missing GOOGLE_API_KEY");
      return "[ERROR]: MAPS_CONFIG — Missing GOOGLE_API_KEY on server.";
    }

    const args =
      typeof toolFunction.arguments === "string"
        ? JSON.parse(toolFunction.arguments || "{}")
        : toolFunction.arguments || {};

    const isRoute = !!args.route;
    const inputLocations = Array.isArray(args.locations) ? args.locations : [];
    const language = args.language || "en";
    const region = args.region || "de";
    const streetSize = args.street_size || "640x400"; // e.g., "800x500"
    const streetFov = args.street_fov ?? 90;          // 10–120
    const streetHeading = args.street_heading;        // optional: 0–360
    const streetPitch = args.street_pitch;            // optional: -90–90

    if (!inputLocations.length) {
      return "[ERROR]: MAPS_INPUT — No locations provided.";
    }

    const normalized = inputLocations.map(normalize).filter(Boolean);
    if (!normalized.length) {
      return "[ERROR]: MAPS_INPUT — Locations are empty after normalization.";
    }

    // Geocode all inputs; prefer compact coordinate strings
    const geo = await Promise.all(normalized.map((s) => geocodeOne(s, { language, region })));
    const points = normalized.map((txt, i) => geo[i]?.coord || txt);

    const minNeeded = isRoute ? 2 : 1;
    if (points.length < minNeeded) {
      return "[ERROR]: MAPS_INPUT — Not enough valid locations for the requested mode.";
    }

    const mapsUrl = buildMapsURLApi1({ points, isRoute, language });

    // Street View: pano link + SERVERSEITIG heruntergeladenes Bild
    let streetPanoLink = "";
    let streetImageUrl = "";   // öffentliche, eigene URL
    let streetImageFile = "";  // relativer Pfad (falls du ihn anzeigen willst)

    const lastCoord = geo[geo.length - 1]?.coord;
    if (lastCoord) {
      streetPanoLink = buildStreetViewPanoURL(lastCoord, language);

      // optionaler Verfügbarkeits-Check
      const sv = await hasStreetView(lastCoord);
      if (sv.ok) {
        const srcUrl = buildStreetViewImageURL(lastCoord, {
          size: streetSize,
          fov: streetFov,
          heading: streetHeading,
          pitch: streetPitch,
        });
        try {
          const saved = await downloadStreetViewToLocal(srcUrl, `streetview-${lastCoord}`);
          streetImageUrl = saved.url;
          streetImageFile = saved.file;
        } catch (e) {
          console.error("[getLocation][streetview-download] error:", e?.response?.data || e?.message || e);
          // Falls Download fehlschlägt, geben wir wenigstens den interaktiven Link zurück
        }
      } else {
        console.warn("[getLocation] No Street View imagery at", lastCoord, "status:", sv.status);
      }
    }

    // Directions (route only)
    let directionsText = "";
    if (isRoute) {
      const origin = points[0];
      const destination = points[points.length - 1];
      const waypoints = points.slice(1, -1);
      directionsText = await getDirectionsText(origin, destination, waypoints, language);
    }

    // Compose output (Text mit Links/URL) — weiterhin textbasiert (kompatibel zu deinem Tool-Contract)
    let out = "";
    if (streetPanoLink) out += `Street View (interactive): ${streetPanoLink}\n`;
    if (streetImageUrl) {
      out += `Street View Image: ${streetImageUrl}\n`;
      // Optional: Dateipfad, falls du ihn im UI anzeigen möchtest
      out += `Street View File: ${streetImageFile}\n`;
    }
    out += `${isRoute ? "Route" : "Location"}: ${mapsUrl}\n\n`;
    if (isRoute) out += directionsText;

    return out.trim();
  } catch (error) {
    console.error("getLocation error:", error?.message || error);
    return "[ERROR]: MAPS_UNEXPECTED — An unexpected error occurred while generating the map links.";
  }
}

module.exports = { getLocation };

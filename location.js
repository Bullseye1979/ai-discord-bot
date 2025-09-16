// location.js — v3.1 (JSON return; robust Street View via pano_id; server-side download)
// - JSON-Return (als String) mit Street View (interactive_url + LOCAL image_url/file) und Maps-Link vorne,
//   directions_text (bei Route) sowie GANZ AM ENDE: description.
// - Nutzt Street View Metadata API; bevorzugt pano_id (falls vorhanden), sonst location=<lat,lon>.
// - Kein Static-Map-Bild.
// ENV: GOOGLE_API_KEY, PUBLIC_BASE_URL (oder BASE_URL als Fallback)

const axios = require("axios");
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// Ablage & URL-Format identisch zu image.js
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
  return ".png";
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

/** Trim coordinate precision (5–6 decimals ~ cm–meter). */
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

/** Build Maps URL using api=1. */
function buildMapsURLApi1({ points, isRoute, language = "en" }) {
  const hl = encodeURIComponent(language || "en");

  if (isRoute) {
    const origin = encodeURIComponent(points[0]);
    const destination = encodeURIComponent(points[points.length - 1]);
    const waypoints = points.slice(1, -1);
    const wp = waypoints.length ? `&waypoints=${encodeURIComponent(waypoints.join("|"))}` : "";
    return `https://www.google.com/maps/dir/?api=1&hl=${hl}&origin=${origin}&destination=${destination}${wp}&travelmode=driving`;
  }

  const query = encodeURIComponent(points[points.length - 1]);
  return `https://www.google.com/maps/search/?api=1&hl=${hl}&query=${query}`;
}

/** Build interactive Street View URL (no key exposure). */
function buildStreetViewPanoURLFromLatLon(latLon, language = "en") {
  const hl = encodeURIComponent(language || "en");
  return `https://www.google.com/maps/@?api=1&hl=${hl}&map_action=pano&viewpoint=${encodeURIComponent(latLon)}`;
}
function buildStreetViewPanoURLFromPanoId(panoId, language = "en") {
  const hl = encodeURIComponent(language || "en");
  return `https://www.google.com/maps/@?api=1&hl=${hl}&map_action=pano&pano=${encodeURIComponent(panoId)}`;
}

/** Build Static Street View URL (server will download it). Accepts panoId OR latLon. */
function buildStreetViewImageURL({ panoId, latLon, size = "640x400", fov = 90, heading, pitch }) {
  const params = new URLSearchParams({ size, fov: String(fov), key: GOOGLE_API_KEY });
  if (panoId) params.set("pano", panoId);
  else params.set("location", latLon);
  if (heading !== undefined) params.set("heading", String(heading));
  if (pitch !== undefined) params.set("pitch", String(pitch));
  return `https://maps.googleapis.com/maps/api/streetview?${params.toString()}`;
}

/** Street View Metadata: try to get pano_id for robustness. */
async function getStreetViewMeta({ latLon }) {
  try {
    const url = "https://maps.googleapis.com/maps/api/streetview/metadata";
    const params = { location: latLon, key: GOOGLE_API_KEY };
    const { data } = await axios.get(url, { params, timeout: 10000 });
    // data contains: status, pano_id?, location?
    return data || {};
  } catch (e) {
    console.error("[getLocation][sv-metadata] error:", e?.response?.data || e?.message || e);
    return {};
  }
}

/** Download Street View image to local pictures dir; return { url, file }. */
async function downloadStreetViewToLocal(imageUrl, nameHint) {
  const res = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 30000 });
  const buf = Buffer.from(res.data);
  const ct = res.headers?.["content-type"] || "image/png";
  const saved = await saveBufferAsPicture(buf, nameHint, ct);
  return {
    url: saved.publicUrl,                         // wie getImage.url
    file: `/documents/pictures/${saved.filename}` // wie getImage.file (relativ)
  };
}

/** Directions text (route). */
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

    const steps = resp.data.routes[0].legs.flatMap((leg) => leg.steps.map((s) => s.html_instructions));
    const textSteps = steps.map((s, i) => `${i + 1}. ${String(s || "").replace(/<[^>]+>/g, "")}`);
    return textSteps.join("\n");
  } catch (e) {
    console.error("[getLocation][directions] error:", e?.response?.data || e?.message || e);
    return "No directions found. (Unexpected error)";
  }
}

/** Tool entry: returns JSON string with street view (image+link) and links first, description last. */
async function getLocation(toolFunction) {
  try {
    if (!GOOGLE_API_KEY) {
      console.error("getLocation: Missing GOOGLE_API_KEY");
      return JSON.stringify({ ok: false, code: "MAPS_CONFIG", error: "Missing GOOGLE_API_KEY on server." });
    }

    const args =
      typeof toolFunction.arguments === "string"
        ? JSON.parse(toolFunction.arguments || "{}")
        : toolFunction.arguments || {};

    const isRoute = !!args.route;
    const inputLocations = Array.isArray(args.locations) ? args.locations : [];
    const language = args.language || "en";
    const region = args.region || "de";
    const streetSize = args.street_size || "640x400";
    const streetFov = args.street_fov ?? 90;
    const streetHeading = args.street_heading;
    const streetPitch = args.street_pitch;

    if (!inputLocations.length) {
      return JSON.stringify({ ok: false, code: "MAPS_INPUT", error: "No locations provided." });
    }

    const normalized = inputLocations.map(normalize).filter(Boolean);
    if (!normalized.length) {
      return JSON.stringify({ ok: false, code: "MAPS_INPUT", error: "Locations empty after normalization." });
    }

    // Geocode all inputs
    const geo = await Promise.all(normalized.map((s) => geocodeOne(s, { language, region })));
    const points = normalized.map((txt, i) => geo[i]?.coord || txt);
    const minNeeded = isRoute ? 2 : 1;
    if (points.length < minNeeded) {
      return JSON.stringify({ ok: false, code: "MAPS_INPUT", error: "Not enough valid locations for requested mode." });
    }

    const mapsUrl = buildMapsURLApi1({ points, isRoute, language });

    // --- Street View robust: try metadata for pano_id, else fall back to lat/lon
    let streetView = {
      interactive_url: "",
      image_url: "",
      file: ""
    };

    const lastCoord = geo[geo.length - 1]?.coord || null;
    let svDescriptionNote = "";
    if (lastCoord) {
      // Interactive
      streetView.interactive_url = buildStreetViewPanoURLFromLatLon(lastCoord, language);

      // Metadata
      const meta = await getStreetViewMeta({ latLon: lastCoord });
      const status = String(meta?.status || "").toUpperCase();

      if (status === "OK") {
        const panoId = meta?.pano_id || meta?.panoId || null;
        const srcUrl = buildStreetViewImageURL({
          panoId,
          latLon: panoId ? undefined : lastCoord,
          size: streetSize,
          fov: streetFov,
          heading: streetHeading,
          pitch: streetPitch
        });

        try {
          const saved = await downloadStreetViewToLocal(srcUrl, `streetview-${panoId || lastCoord}`);
          streetView.image_url = saved.url;
          streetView.file = saved.file;
        } catch (e) {
          console.error("[getLocation][streetview-download] error:", e?.response?.data || e?.message || e);
          svDescriptionNote = "Street View image download failed; interactive link provided.";
        }
      } else {
        // Fallback: try direct image by location anyway (manche Orte liefern OK beim Bild trotz ZERO_RESULTS in Metadata)
        try {
          const srcUrl = buildStreetViewImageURL({
            panoId: null,
            latLon: lastCoord,
            size: streetSize,
            fov: streetFov,
            heading: streetHeading,
            pitch: streetPitch
          });
          const saved = await downloadStreetViewToLocal(srcUrl, `streetview-${lastCoord}`);
          streetView.image_url = saved.url;
          streetView.file = saved.file;
          svDescriptionNote = `Metadata status ${status}, but image by location succeeded.`;
        } catch (e) {
          console.warn("[getLocation] No Street View imagery resolvable at", lastCoord, "status:", status);
          svDescriptionNote = `No Street View image at ${lastCoord} (status: ${status}).`;
        }
      }
    } else {
      svDescriptionNote = "No geocoded coordinate for Street View.";
    }

    // Directions (if route)
    let directionsText = "";
    if (isRoute) {
      const origin = points[0];
      const destination = points[points.length - 1];
      const waypoints = points.slice(1, -1);
      directionsText = await getDirectionsText(origin, destination, waypoints, language);
    }

    // Build description LAST (so es nicht abgeschnitten wird)
    const descParts = [];
    if (isRoute) descParts.push("Driving directions are included below the links.");
    descParts.push(svDescriptionNote || "Street View image and interactive link generated.");
    const description = descParts.filter(Boolean).join(" ");

    // Final JSON (stringify)
    const payload = {
      ok: true,
      street_view: streetView,       // <-- vorne
      maps_url: mapsUrl,             // <-- vorne
      directions_text: directionsText || "", // optional
      inputs: {
        is_route: isRoute,
        locations: normalized,
        language,
        region,
        street_size: streetSize,
        street_fov: streetFov,
        street_heading: streetHeading ?? null,
        street_pitch: streetPitch ?? null
      },
      description                      // <-- ganz am Ende
    };

    return JSON.stringify(payload);
  } catch (error) {
    console.error("getLocation error:", error?.message || error);
    return JSON.stringify({ ok: false, code: "MAPS_UNEXPECTED", error: "Unexpected error while generating map links." });
  }
}

module.exports = { getLocation };

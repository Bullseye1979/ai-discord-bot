// location.js — v3.9 (no locale; returns PLAIN STRING with one URL per line)
// - Rückgabe: Plain-Text-String (kein JSON, kein Objekt):
//     <static_street_view_image_url>
//     <interactive_street_view_url>
//     <google_maps_url>
//     (leerzeile)
//     <directions_text>
// - Static Street View: serverseitiger Download → eigene dauerhafte URL,
//   Fallback: direkte Google-Static-Street-View-URL, falls Download fehlschlägt.
// - Keine Locale-Parameter (hl/language/region).
// ENV: GOOGLE_API_KEY, PUBLIC_BASE_URL (oder BASE_URL)

const axios = require("axios");
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const PICTURES_DIR = path.join(__dirname, "documents", "pictures");

/* --------------------------- helpers: storage/urls -------------------------- */
function ensureAbsoluteUrl(urlPath) {
  const base = (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "").replace(/\/$/, "");
  const normalized = String(urlPath || "").replace(/\\/g, "/");
  if (/^https?:\/\//i.test(normalized)) return normalized;
  if (base) return `${base}${normalized.startsWith("/") ? "" : "/"}${normalized}`;
  return normalized;
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
  const publicRel = `/documents/pictures/${filename}`.replace(/\\/g, "/");
  const publicUrl = ensureAbsoluteUrl(publicRel);
  return { filename, filePath, publicUrl };
}

/* ------------------------------ helpers: misc ------------------------------- */
function isLatLon(input) {
  return /^\s*-?\d{1,2}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*$/.test(String(input || ""));
}
function normalize(s) {
  return String(s || "").trim().replace(/^[,;]+|[,;]+$/g, "").replace(/\s{2,}/g, " ");
}
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

/* ------------------------------ geocoding opt ------------------------------- */
async function geocodeOne(query) {
  const q = normalize(query);
  if (!q) return null;
  if (isLatLon(q)) {
    const [lat, lng] = q.split(",").map((x) => x.trim());
    const trimmed = trimLatLng(lat, lng) || `${lat},${lng}`;
    return { coord: trimmed, address: q, plusCode: null };
  }
  try {
    const { data } = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: { address: q, key: GOOGLE_API_KEY },
      timeout: 20000,
    });
    const { status, results } = data || {};
    if (status !== "OK" || !Array.isArray(results) || !results.length) return null;
    const r0 = results[0];
    const lat = r0?.geometry?.location?.lat;
    const lng = r0?.geometry?.location?.lng;
    const trimmed = trimLatLng(lat, lng);
    if (!trimmed) return null;
    const plusCode = r0?.plus_code?.global_code || r0?.plus_code?.compound_code || null;
    return { coord: trimmed, address: r0?.formatted_address || q, plusCode };
  } catch {
    return null;
  }
}

/* ------------------------------ maps & street ------------------------------- */
function buildMapsURLApi1({ points, isRoute }) {
  if (isRoute) {
    const origin = encodeURIComponent(points[0]);
    const destination = encodeURIComponent(points[points.length - 1]);
    const waypoints = points.slice(1, -1);
    const wp = waypoints.length ? `&waypoints=${encodeURIComponent(waypoints.join("|"))}` : "";
    return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}${wp}&travelmode=driving`;
  }
  const query = encodeURIComponent(points[points.length - 1]);
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}
function buildStreetViewPanoURLFromLatLon(latLon) {
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${encodeURIComponent(latLon)}`;
}
function buildStreetViewPanoURLFromPanoId(panoId) {
  return `https://www.google.com/maps/@?api=1&map_action=pano&pano=${encodeURIComponent(panoId)}`;
}
function buildStreetViewImageURL({ panoId, latLon, address, size = "640x400", fov = 90, heading, pitch }) {
  const params = new URLSearchParams({ size, fov: String(fov), key: GOOGLE_API_KEY });
  if (panoId) params.set("pano", panoId);
  else if (latLon) params.set("location", latLon);
  else if (address) params.set("location", address);
  if (heading !== undefined) params.set("heading", String(heading));
  if (pitch !== undefined) params.set("pitch", String(pitch));
  return `https://maps.googleapis.com/maps/api/streetview?${params.toString()}`;
}
async function getStreetViewMeta({ latLon, address }) {
  try {
    const params = { key: GOOGLE_API_KEY };
    if (latLon) params.location = latLon; else if (address) params.location = address; else return {};
    const { data } = await axios.get("https://maps.googleapis.com/maps/api/streetview/metadata", { params, timeout: 10000 });
    return data || {};
  } catch {
    return {};
  }
}
async function getDirectionsDetail(origin, destination, waypoints = []) {
  try {
    const params = { origin, destination, mode: "driving", key: GOOGLE_API_KEY };
    if (waypoints.length) params.waypoints = waypoints.join("|");
    const { data } = await axios.get("https://maps.googleapis.com/maps/api/directions/json", { params, timeout: 20000 });
    const { status, routes } = data || {};
    if (status !== "OK" || !routes?.length) return { text: `No directions found. (${status || "UNKNOWN"})`, endCoord: null };
    const r0 = routes[0];
    const steps = r0.legs.flatMap((leg) => leg.steps.map((s) => s.html_instructions));
    const text = steps.map((s, i) => `${i + 1}. ${String(s || "").replace(/<[^>]+>/g, "")}`).join("\n");
    const lastLeg = r0.legs[r0.legs.length - 1];
    const el = lastLeg?.end_location;
    const endCoord = (el && typeof el.lat === "number" && typeof el.lng === "number") ? trimLatLng(el.lat, el.lng) : null;
    return { text, endCoord };
  } catch {
    return { text: "No directions found. (Unexpected error)", endCoord: null };
  }
}
async function downloadStreetViewToLocal(imageUrl, nameHint) {
  const res = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 30000, validateStatus: () => true });
  const ct = String(res.headers?.["content-type"] || "").toLowerCase();
  if (!ct.startsWith("image/")) throw new Error("STREETVIEW_NON_IMAGE");
  const buf = Buffer.from(res.data);
  const saved = await saveBufferAsPicture(buf, nameHint, ct || "image/png");
  return { url: saved.publicUrl, filePath: saved.filePath };
}

/* ---------------------------------- Tool ----------------------------------- */
/** Tool entry: returns PLAIN STRING (URLs je Zeile; danach optional directions_text) */
async function getLocation(toolFunction) {
  try {
    // parse args früh, um robust zu bleiben (auch bei fehlendem Key)
    const rawArgs = typeof toolFunction?.arguments === "string"
      ? JSON.parse(toolFunction.arguments || "{}")
      : (toolFunction?.arguments || {});

    if (!GOOGLE_API_KEY) {
      // Klartext-Fehler (Plain String)
      return "[ERROR]: MAPS_CONFIG — Missing GOOGLE_API_KEY on server.";
    }

    const isRoute = !!rawArgs.route;
    const inputLocations = Array.isArray(rawArgs.locations) ? rawArgs.locations : [];
    const streetSize = rawArgs.street_size || "640x400";
    const streetFov = rawArgs.street_fov ?? 90;
    const streetHeading = rawArgs.street_heading;
    const streetPitch = rawArgs.street_pitch;

    if (!inputLocations.length) return "[ERROR]: MAPS_INPUT — No locations provided.";

    const normalized = inputLocations.map(normalize).filter(Boolean);
    if (!normalized.length) return "[ERROR]: MAPS_INPUT — Locations empty after normalization.";

    const geo = await Promise.all(normalized.map((s) => geocodeOne(s)));
    const points = normalized.map((txt, i) => geo[i]?.coord || txt);

    const mapsUrl = buildMapsURLApi1({ points, isRoute });

    let directionsText = "";
    let endCoordFromDirections = null;
    if (isRoute) {
      const origin = points[0];
      const destination = points[points.length - 1];
      const waypoints = points.slice(1, -1);
      const dir = await getDirectionsDetail(origin, destination, waypoints);
      directionsText = dir.text;
      endCoordFromDirections = dir.endCoord;
    }

    const destIdx = normalized.length - 1;
    const coordFromGeocode = geo[destIdx]?.coord || null;
    const destAddress = normalized[destIdx];
    const svCoord = coordFromGeocode || endCoordFromDirections || null;

    let interactive = "";
    let imageSrc = "";

    const meta = await getStreetViewMeta({ latLon: svCoord, address: svCoord ? null : destAddress });
    const status = String(meta?.status || "").toUpperCase();

    if (status === "OK") {
      const panoId = meta?.pano_id || meta?.panoId || null;
      if (panoId) {
        interactive = buildStreetViewPanoURLFromPanoId(panoId);
        imageSrc = buildStreetViewImageURL({ panoId, size: streetSize, fov: streetFov, heading: streetHeading, pitch: streetPitch });
      } else {
        const mLoc = meta?.location;
        const metaLatLon = (mLoc && typeof mLoc.lat === "number" && typeof mLoc.lng === "number")
          ? trimLatLng(mLoc.lat, mLoc.lng)
          : (svCoord || null);
        if (metaLatLon) {
          interactive = buildStreetViewPanoURLFromLatLon(metaLatLon);
          imageSrc = buildStreetViewImageURL({ latLon: metaLatLon, size: streetSize, fov: streetFov, heading: streetHeading, pitch: streetPitch });
        } else {
          imageSrc = buildStreetViewImageURL({ address: destAddress, size: streetSize, fov: streetFov, heading: streetHeading, pitch: streetPitch });
        }
      }
    } else {
      imageSrc = buildStreetViewImageURL({ address: destAddress, size: streetSize, fov: streetFov, heading: streetHeading, pitch: streetPitch });
    }

    // Static Street View Bild bevorzugt als eigene URL (Download), sonst Google-URL
    let imageUrl = "";
    if (imageSrc) {
      try {
        const saved = await downloadStreetViewToLocal(imageSrc, `streetview-${svCoord || destAddress}`);
        imageUrl = saved.url; // eigene, dauerhafte URL
      } catch {
        imageUrl = imageSrc;  // Fallback: direkte Google-URL
      }
    }

    if (!interactive) {
      interactive = svCoord
        ? buildStreetViewPanoURLFromLatLon(svCoord)
        : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(destAddress)}`;
    }

    // === FINAL: Plain-Text-String ===
    // Zeile 1: Static Street View Image URL (für Discord-Bildvorschau)
    // Zeile 2: Interaktive Street View URL
    // Zeile 3: Google Maps (Route/Location)
    // Leerzeile
    // Danach: directions_text (falls vorhanden)
    const lines = ["Streetview Image: "+imageUrl,"Interactive Streetview: "+interactive,"Google Maps: "+mapsUrl].filter(Boolean);
    let out = lines.join(" \n ");
    if (directionsText) out += `\n\n${directionsText}`;
    return out;
  } catch (error) {
    return "[ERROR]: MAPS_UNEXPECTED — Unexpected error while generating map links.";
  }
}

module.exports = { getLocation };

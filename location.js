// location.js — v3.2 (JSON return; robust without Geocoding; server-side Street View download)
// - JSON-Return (als String). Reihenfolge: street_view, maps_url, directions_text, inputs, description (letztes Feld).
// - Nutzt Street View Metadata API (pano_id bevorzugt) und lädt Static Street View serverseitig herunter.
// - Fallbacks: (1) Geocoded Koordinate, (2) Ziel-Koordinate aus Directions API, (3) direkte Address-Location bei SV.
// - Keine Static-Map.
// ENV: GOOGLE_API_KEY, PUBLIC_BASE_URL (oder BASE_URL)

const axios = require("axios");
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// — Ablage & URL-Format identisch zu image.js —
const PICTURES_DIR = path.join(__dirname, "documents", "pictures");

function ensureAbsoluteUrl(urlPath) {
  const base = (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "").replace(/\/$/, "");
  if (/^https?:\/\//i.test(urlPath)) return urlPath;
  if (base) return `${base}${urlPath.startsWith("/") ? "" : "/"}${urlPath}`;
  return urlPath;
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

// — Helpers —

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

// Geocoding (optional; falls API nicht aktiv, kommt hier null zurück)
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
    const { status, results } = resp.data || {};
    if (status !== "OK" || !Array.isArray(results) || !results.length) {
      console.warn("[getLocation][geocode] status:", status, "q:", q);
      return null;
    }
    const r0 = results[0];
    const lat = r0?.geometry?.location?.lat;
    const lng = r0?.geometry?.location?.lng;
    const trimmed = trimLatLng(lat, lng);
    if (!trimmed) return null;
    const plusCode = r0?.plus_code?.global_code || r0?.plus_code?.compound_code || null;
    return { coord: trimmed, address: r0?.formatted_address || q, plusCode };
  } catch (e) {
    console.warn("[getLocation][geocode] error:", e?.response?.data || e?.message || e);
    return null;
  }
}

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

function buildStreetViewPanoURLFromLatLon(latLon, language = "en") {
  const hl = encodeURIComponent(language || "en");
  return `https://www.google.com/maps/@?api=1&hl=${hl}&map_action=pano&viewpoint=${encodeURIComponent(latLon)}`;
}
function buildStreetViewPanoURLFromPanoId(panoId, language = "en") {
  const hl = encodeURIComponent(language || "en");
  return `https://www.google.com/maps/@?api=1&hl=${hl}&map_action=pano&pano=${encodeURIComponent(panoId)}`;
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

// Street View Metadata: akzeptiert pano, latlon ODER address als location
async function getStreetViewMeta({ latLon, address }) {
  try {
    const params = { key: GOOGLE_API_KEY };
    if (latLon) params.location = latLon;
    else if (address) params.location = address;
    else return {};
    const url = "https://maps.googleapis.com/maps/api/streetview/metadata";
    const { data } = await axios.get(url, { params, timeout: 10000 });
    return data || {};
  } catch (e) {
    console.warn("[getLocation][sv-metadata] error:", e?.response?.data || e?.message || e);
    return {};
  }
}

// Directions: liefert Text + Ziel-Koordinate (end_location) für Fallback
async function getDirectionsDetail(origin, destination, waypoints = [], language = "en") {
  try {
    const params = {
      origin, destination, mode: "driving", key: GOOGLE_API_KEY, language
    };
    if (waypoints.length) params.waypoints = waypoints.join("|");
    const resp = await axios.get("https://maps.googleapis.com/maps/api/directions/json", {
      params, timeout: 20000,
    });
    const { status, routes } = resp.data || {};
    if (status !== "OK" || !routes?.length) {
      console.error("[getLocation][directions] status:", status);
      return { text: `No directions found. (${status || "UNKNOWN"})`, endCoord: null };
    }
    const r0 = routes[0];
    const steps = r0.legs.flatMap((leg) => leg.steps.map((s) => s.html_instructions));
    const text = steps.map((s, i) => `${i + 1}. ${String(s || "").replace(/<[^>]+>/g, "")}`).join("\n");

    // End-Koordinate der letzten Leg als Fallback-Coord
    const lastLeg = r0.legs[r0.legs.length - 1];
    const el = lastLeg?.end_location;
    const endCoord = (el && typeof el.lat === "number" && typeof el.lng === "number")
      ? trimLatLng(el.lat, el.lng)
      : null;

    return { text, endCoord };
  } catch (e) {
    console.error("[getLocation][directions] error:", e?.response?.data || e?.message || e);
    return { text: "No directions found. (Unexpected error)", endCoord: null };
  }
}

async function downloadStreetViewToLocal(imageUrl, nameHint) {
  const res = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 30000 });
  const buf = Buffer.from(res.data);
  const ct = res.headers?.["content-type"] || "image/png";
  const saved = await saveBufferAsPicture(buf, nameHint, ct);
  return { url: saved.publicUrl, file: `/documents/pictures/${saved.filename}` };
}

/** Tool entry (JSON string): street_view & links first, description last. */
async function getLocation(toolFunction) {
  try {
    if (!GOOGLE_API_KEY) {
      return JSON.stringify({ ok: false, code: "MAPS_CONFIG", error: "Missing GOOGLE_API_KEY on server." });
    }

    const args =
      typeof toolFunction.arguments === "string"
        ? JSON.parse(toolFunction.arguments || "{}")
        : (toolFunction.arguments || {});

    const isRoute = !!args.route;
    const inputLocations = Array.isArray(args.locations) ? args.locations : [];
    const language = args.language || "de";
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

    // 1) Versuche Geocoding (falls API aktiv)
    const geo = await Promise.all(normalized.map((s) => geocodeOne(s, { language, region })));
    const points = normalized.map((txt, i) => geo[i]?.coord || txt);

    // 2) Maps-Link
    const mapsUrl = buildMapsURLApi1({ points, isRoute, language });

    // 3) Directions + möglicher End-Koordinaten-Fallback
    let directionsText = "";
    let endCoordFromDirections = null;
    if (isRoute) {
      const origin = points[0];
      const destination = points[points.length - 1];
      const waypoints = points.slice(1, -1);
      const dir = await getDirectionsDetail(origin, destination, waypoints, language);
      directionsText = dir.text;
      endCoordFromDirections = dir.endCoord;
    }

    // 4) Bestimme Ziel-Koordinate für Street View
    const destIdx = normalized.length - 1;
    const coordFromGeocode = geo[destIdx]?.coord || null;
    const destAddress = normalized[destIdx];
    let svCoord = coordFromGeocode || endCoordFromDirections || null;

    // 5) Street View (Metadata → pano_id bevorzugen)
    const streetView = { interactive_url: "", image_url: "", file: "" };
    let svNote = "";

    // Metadaten mit Koordinate oder (falls keine Koordinate) direkt mit Adresse
    const meta = await getStreetViewMeta({ latLon: svCoord, address: svCoord ? null : destAddress });
    const status = String(meta?.status || "").toUpperCase();

    if (status === "OK") {
      const panoId = meta?.pano_id || meta?.panoId || null;
      let interactive = "";
      let imageSrc = "";

      if (panoId) {
        interactive = buildStreetViewPanoURLFromPanoId(panoId, language);
        imageSrc = buildStreetViewImageURL({ panoId, size: streetSize, fov: streetFov, heading: streetHeading, pitch: streetPitch });
      } else {
        // Fallback: nutze Location aus Meta (oder svCoord/destAddress)
        const mLoc = meta?.location;
        const metaLatLon = (mLoc && typeof mLoc.lat === "number" && typeof mLoc.lng === "number")
          ? trimLatLng(mLoc.lat, mLoc.lng)
          : (svCoord || null);

        if (metaLatLon) {
          interactive = buildStreetViewPanoURLFromLatLon(metaLatLon, language);
          imageSrc = buildStreetViewImageURL({ latLon: metaLatLon, size: streetSize, fov: streetFov, heading: streetHeading, pitch: streetPitch });
        } else {
          // äußerster Fallback: direkt Adresse versuchen
          interactive = ""; // ohne Koordinate schwer zuverlässig
          imageSrc = buildStreetViewImageURL({ address: destAddress, size: streetSize, fov: streetFov, heading: streetHeading, pitch: streetPitch });
        }
      }

      try {
        const saved = await downloadStreetViewToLocal(imageSrc, `streetview-${panoId || svCoord || destAddress}`);
        streetView.image_url = saved.url;
        streetView.file = saved.file;
        streetView.interactive_url = interactive || (svCoord ? buildStreetViewPanoURLFromLatLon(svCoord, language) : "");
        if (!streetView.interactive_url) {
          // als allerletztes: versuche mit der Adresse eine Pano-URL (nicht ideal)
          streetView.interactive_url = `https://www.google.com/maps/search/?api=1&hl=${encodeURIComponent(language)}&query=${encodeURIComponent(destAddress)}`;
        }
        svNote = "Street View image and interactive link generated.";
      } catch (e) {
        console.error("[getLocation][streetview-download] error:", e?.response?.data || e?.message || e);
        streetView.interactive_url = interactive || (svCoord ? buildStreetViewPanoURLFromLatLon(svCoord, language) : "");
        svNote = "Street View image download failed; interactive link provided.";
      }
    } else {
      // Wenn Metadata nicht OK, versuche trotzdem direkt mit Adresse ein Bild zu holen
      try {
        const imageSrc = buildStreetViewImageURL({ address: destAddress, size: streetSize, fov: streetFov, heading: streetHeading, pitch: streetPitch });
        const saved = await downloadStreetViewToLocal(imageSrc, `streetview-${destAddress}`);
        streetView.image_url = saved.url;
        streetView.file = saved.file;
        streetView.interactive_url = svCoord
          ? buildStreetViewPanoURLFromLatLon(svCoord, language)
          : `https://www.google.com/maps/search/?api=1&hl=${encodeURIComponent(language)}&query=${encodeURIComponent(destAddress)}`;
        svNote = `Street View by address (metadata status: ${status || "UNKNOWN"}).`;
      } catch (_) {
        svNote = `No Street View image (metadata status: ${status || "UNKNOWN"}).`;
        // interactive_url leer lassen, wenn auch keine Coord vorliegt
        if (svCoord) streetView.interactive_url = buildStreetViewPanoURLFromLatLon(svCoord, language);
      }
    }

    // 6) Beschreibung als LETZTES Feld
    const descriptionParts = [];
    if (coordFromGeocode) {
      descriptionParts.push(`Used geocoded coord ${coordFromGeocode} for Street View.`);
    } else if (endCoordFromDirections) {
      descriptionParts.push(`Geocoding unavailable; used Directions end coord ${endCoordFromDirections}.`);
    } else {
      descriptionParts.push("No coord from Geocoding or Directions; tried address for Street View.");
    }
    descriptionParts.push(svNote || "");
    const description = descriptionParts.filter(Boolean).join(" ");

    const payload = {
      ok: true,
      street_view: streetView,           // zuerst
      maps_url: mapsUrl,                 // davor
      directions_text: directionsText || "",
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
      description                          // LETZTES Feld
    };

    return JSON.stringify(payload);
  } catch (error) {
    console.error("getLocation error:", error?.message || error);
    return JSON.stringify({ ok: false, code: "MAPS_UNEXPECTED", error: "Unexpected error while generating map links." });
  }
}

module.exports = { getLocation };

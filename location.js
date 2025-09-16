// location.js — v3.5 (no locale; JSON return; robust Street View; server-side download)
// - Keine Sprache/Region: es werden nirgendwo language/region/hl-Parameter gesetzt.
// - Rückgabe ist EIN JSON-String. Reihenfolge: street_view, maps_url, directions_text, inputs, description (letztes Feld).
// - Street View: Metadata (pano_id bevorzugt) → Static Street View serverseitig speichern (gleiches Schema wie getImage).
// - Fallbacks: (1) Geocoded-Koordinate, (2) Directions-Endkoordinate, (3) Adresse direkt an SV-API.
// - Keine Static-Map.
// ENV: GOOGLE_API_KEY, PUBLIC_BASE_URL (oder BASE_URL)

const axios = require("axios");
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// Ablage & URL-Format wie image.js
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

// Helpers

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

// Geocoding (ohne language/region)
async function geocodeOne(query) {
  const q = normalize(query);
  if (!q) return null;

  if (isLatLon(q)) {
    const [lat, lng] = q.split(",").map((x) => x.trim());
    const trimmed = trimLatLng(lat, lng) || `${lat},${lng}`;
    return { coord: trimmed, address: q, plusCode: null };
  }

  try {
    const resp = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: { address: q, key: GOOGLE_API_KEY },
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

// Maps-URL via api=1 (ohne hl)
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

// Street View Pano-Links (ohne hl)
function buildStreetViewPanoURLFromLatLon(latLon) {
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${encodeURIComponent(latLon)}`;
}
function buildStreetViewPanoURLFromPanoId(panoId) {
  return `https://www.google.com/maps/@?api=1&map_action=pano&pano=${encodeURIComponent(panoId)}`;
}

// Static Street View Image URL
function buildStreetViewImageURL({ panoId, latLon, address, size = "640x400", fov = 90, heading, pitch }) {
  const params = new URLSearchParams({ size, fov: String(fov), key: GOOGLE_API_KEY });
  if (panoId) params.set("pano", panoId);
  else if (latLon) params.set("location", latLon);
  else if (address) params.set("location", address);
  if (heading !== undefined) params.set("heading", String(heading));
  if (pitch !== undefined) params.set("pitch", String(pitch));
  return `https://maps.googleapis.com/maps/api/streetview?${params.toString()}`;
}

// Street View Metadata (ohne locale)
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

// Directions (ohne language)
async function getDirectionsDetail(origin, destination, waypoints = []) {
  try {
    const params = { origin, destination, mode: "driving", key: GOOGLE_API_KEY };
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

// Download Street View und sicherstellen, dass es ein Bild ist
async function downloadStreetViewToLocal(imageUrl, nameHint) {
  const res = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 30000, validateStatus: () => true });
  const ct = String(res.headers?.["content-type"] || "").toLowerCase();

  if (!ct.startsWith("image/")) {
    try {
      const txt = Buffer.from(res.data).toString("utf8");
      const maybeJson = JSON.parse(txt);
      const status = maybeJson?.status || maybeJson?.error_message || "NON_IMAGE_RESPONSE";
      throw new Error(`STREETVIEW_NON_IMAGE (${status})`);
    } catch {
      throw new Error(`STREETVIEW_NON_IMAGE (${ct || "unknown content-type"})`);
    }
  }

  const buf = Buffer.from(res.data);
  const saved = await saveBufferAsPicture(buf, nameHint, ct || "image/png");
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

    // 1) Optionales Geocoding
    const geo = await Promise.all(normalized.map((s) => geocodeOne(s)));
    const points = normalized.map((txt, i) => geo[i]?.coord || txt);

    // 2) Maps-Link (ohne hl)
    const mapsUrl = buildMapsURLApi1({ points, isRoute });

    // 3) Directions + evtl. Endkoordinaten-Fallback
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

    // 4) Ziel-Koordinate/Adresse für Street View
    const destIdx = normalized.length - 1;
    const coordFromGeocode = geo[destIdx]?.coord || null;
    const destAddress = normalized[destIdx];
    let svCoord = coordFromGeocode || endCoordFromDirections || null;

    // 5) Street View
    const streetView = { interactive_url: "", image_url: "", file: "" };
    let svNote = "";

    const meta = await getStreetViewMeta({ latLon: svCoord, address: svCoord ? null : destAddress });
    const status = String(meta?.status || "").toUpperCase();

    if (status === "OK") {
      const panoId = meta?.pano_id || meta?.panoId || null;
      let interactive = "";
      let imageSrc = "";

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
          interactive = "";
          imageSrc = buildStreetViewImageURL({ address: destAddress, size: streetSize, fov: streetFov, heading: streetHeading, pitch: streetPitch });
        }
      }

      try {
        const saved = await downloadStreetViewToLocal(imageSrc, `streetview-${panoId || svCoord || destAddress}`);
        streetView.image_url = saved.url;
        streetView.file = saved.file;
        streetView.interactive_url = interactive || (svCoord ? buildStreetViewPanoURLFromLatLon(svCoord) : "");
        if (!streetView.interactive_url) {
          streetView.interactive_url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(destAddress)}`;
        }
        svNote = "Street View image and interactive link generated.";
      } catch (e) {
        console.error("[getLocation][streetview-download] error:", e?.response?.data || e?.message || e);
        streetView.interactive_url = interactive || (svCoord ? buildStreetViewPanoURLFromLatLon(svCoord) : "");
        svNote = "Street View image download failed; interactive link provided.";
      }
    } else {
      try {
        const imageSrc = buildStreetViewImageURL({ address: destAddress, size: streetSize, fov: streetFov, heading: streetHeading, pitch: streetPitch });
        const saved = await downloadStreetViewToLocal(imageSrc, `streetview-${destAddress}`);
        streetView.image_url = saved.url;
        streetView.file = saved.file;
        streetView.interactive_url = svCoord
          ? buildStreetViewPanoURLFromLatLon(svCoord)
          : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(destAddress)}`;
        svNote = `Street View by address (metadata status: ${status || "UNKNOWN"}).`;
      } catch (e) {
        console.warn("[getLocation] No Street View imagery resolvable. status:", status, "err:", e?.message || e);
        if (svCoord) streetView.interactive_url = buildStreetViewPanoURLFromLatLon(svCoord);
        svNote = `No Street View image (metadata status: ${status || "UNKNOWN"}).`;
      }
    }

    // 6) Beschreibung als letztes Feld
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
      street_view: streetView,
      maps_url: mapsUrl,
      directions_text: directionsText || "",
      inputs: {
        is_route: isRoute,
        locations: normalized,
        street_size: streetSize,
        street_fov: streetFov,
        street_heading: streetHeading ?? null,
        street_pitch: streetPitch ?? null
      },
      description // letztes Feld
    };

    return JSON.stringify(payload);
  } catch (error) {
    console.error("getLocation error:", error?.message || error);
    return JSON.stringify({ ok: false, code: "MAPS_UNEXPECTED", error: "Unexpected error while generating map links." });
  }
}

module.exports = { getLocation };

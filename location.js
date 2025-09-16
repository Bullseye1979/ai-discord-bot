// location.js — v2.5 (GOOGLE_API_KEY + Static Map + Street View image)
// Build Google Maps (route/search) links via api=1, optional Street View pano link,
// plus human-readable driving directions via Directions API.
// NEW: Static Map (route image) and Street View Static Image URLs.
// ENV: GOOGLE_API_KEY (was: GOOGLE_MAPS_API_KEY)

const axios = require("axios");

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

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

/** Build Street View (pano) URL using api=1 (does not expose API key). */
function buildStreetViewPanoURL(latLon, language = "en") {
  const hl = encodeURIComponent(language || "en");
  return `https://www.google.com/maps/@?api=1&hl=${hl}&map_action=pano&viewpoint=${encodeURIComponent(latLon)}`;
}

/** Build Street View Static Image URL (exposes key; lock API restrictions!). */
function buildStreetViewImageURL(latLon, { size = "640x400" } = {}) {
  const params = new URLSearchParams({
    size,
    location: latLon,
    key: GOOGLE_API_KEY,
  });
  return `https://maps.googleapis.com/maps/api/streetview?${params.toString()}`;
}

/** Build Static Map URL.
 * If polyline is present, draw path; else show markers for origin/destination.
 * Note: Contains API key → restrict usage!
 */
function buildStaticMapURL({ origin, destination, waypoints = [], polyline = "", size = "640x400" }) {
  const base = "https://maps.googleapis.com/maps/api/staticmap";
  const qp = new URLSearchParams();
  qp.set("size", size);
  qp.set("key", GOOGLE_API_KEY);

  // Markers
  if (origin) qp.append("markers", `color:green|label:S|${origin}`);
  if (destination) qp.append("markers", `color:red|label:E|${destination}`);
  for (const w of waypoints) qp.append("markers", `color:blue|${w}`);

  if (polyline) {
    // Draw route via encoded polyline (single path param)
    qp.append("path", `weight:5|color:0x0000ff|enc:${polyline}`);
  } else if (origin && destination) {
    // As fallback, draw a simple path with points (no polyline)
    const pts = [origin, ...waypoints, destination].join("|");
    qp.append("path", `weight:5|color:0x0000ff|${pts}`);
  }

  return `${base}?${qp.toString()}`;
}

/** Get directions: returns { text, polyline }.
 * Degrades gracefully if Directions API is not enabled/allowed.
 */
async function getDirections(origin, destination, waypoints = [], language = "en") {
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
      return { text: `No directions found. (${hint})`, polyline: "" };
    }

    const route0 = routes[0];
    const polyline = route0?.overview_polyline?.points || "";

    const steps = route0.legs.flatMap((leg) => leg.steps.map((s) => s.html_instructions));
    const textSteps = steps.map((s, i) => `${i + 1}. ${String(s || "").replace(/<[^>]+>/g, "")}`);
    return { text: textSteps.join("\n"), polyline };
  } catch (e) {
    console.error("[getLocation][directions] error:", e?.response?.data || e?.message || e);
    return { text: "No directions found. (Unexpected error)", polyline: "" };
  }
}

/** Tool entry: return Street View links & images, Maps link, Static Map (route image), and directions (if route). */
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
    const staticSize = args.static_size || "640x400"; // e.g., "800x500"

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

    // Build Street View links/images for the last location if geocoded
    let streetPanoLink = "";
    let streetImage = "";
    const lastCoord = geo[geo.length - 1]?.coord;
    if (lastCoord) {
      streetPanoLink = buildStreetViewPanoURL(lastCoord, language);
      streetImage = buildStreetViewImageURL(lastCoord, { size: staticSize });
    }

    // If route: fetch directions + polyline for static map
    let directionsText = "";
    let staticMapUrl = "";
    if (isRoute) {
      const origin = points[0];
      const destination = points[points.length - 1];
      const waypoints = points.slice(1, -1);

      const { text, polyline } = await getDirections(origin, destination, waypoints, language);
      directionsText = text;
      staticMapUrl = buildStaticMapURL({
        origin,
        destination,
        waypoints,
        polyline,
        size: staticSize,
      });
    } else {
      // Non-route: just a static map centered on the place (as marker)
      const center = points[points.length - 1];
      staticMapUrl = buildStaticMapURL({
        origin: center,
        destination: "",
        waypoints: [],
        polyline: "",
        size: staticSize,
      });
    }

    // Compose output (text with links). Keep backward-compatible format.
    let out = "";
    if (streetPanoLink) out += `Street View (interactive): ${streetPanoLink}\n`;
    if (streetImage) out += `Street View Image: ${streetImage}\n`;
    out += `${isRoute ? "Route" : "Location"}: ${mapsUrl}\n`;
    if (staticMapUrl) out += `Static Map Image: ${staticMapUrl}\n\n`;
    if (isRoute) out += directionsText;

    return out.trim();
  } catch (error) {
    console.error("getLocation error:", error?.message || error);
    return "[ERROR]: MAPS_UNEXPECTED — An unexpected error occurred while generating the map links.";
  }
}

module.exports = { getLocation };

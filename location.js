// location.js — clean v2.0 (no URL shortener)
// Build Google Maps (route/search) links via api=1, optional Street View (maps pano link),
// plus human-readable driving directions via Directions API.

const axios = require("axios");

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

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
      params: { address: q, key: GOOGLE_MAPS_API_KEY, language, region },
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

/** Build Street View (pano) URL using api=1 (shorter than Static API image link). */
function buildStreetViewURL(latLon, language = "en") {
  const hl = encodeURIComponent(language || "en");
  // Opens interactive Street View at viewpoint (short & no API key in URL).
  return `https://www.google.com/maps/@?api=1&hl=${hl}&map_action=pano&viewpoint=${encodeURIComponent(latLon)}`;
}

/** Get human-readable driving directions text (EN by default). */
async function getDirectionsText(origin, destination, waypoints = [], language = "en") {
  try {
    const params = {
      origin,
      destination,
      mode: "driving",
      key: GOOGLE_MAPS_API_KEY,
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
      return "No directions found.";
    }
    const steps = routes[0].legs.flatMap((leg) => leg.steps.map((s) => s.html_instructions));
    const textSteps = steps.map((s, i) => `${i + 1}. ${String(s || "").replace(/<[^>]+>/g, "")}`);
    return textSteps.join("\n");
  } catch (e) {
    console.error("[getLocation][directions] error:", e?.response?.data || e?.message || e);
    return "No directions found.";
  }
}

/** Tool entry: return Street View (if available), Maps link, and directions (if route). */
async function getLocation(toolFunction) {
  try {
    if (!GOOGLE_MAPS_API_KEY) {
      console.error("getLocation: Missing GOOGLE_MAPS_API_KEY");
      return "[ERROR]: MAPS_CONFIG — Missing GOOGLE_MAPS_API_KEY on server.";
    }

    const args =
      typeof toolFunction.arguments === "string"
        ? JSON.parse(toolFunction.arguments || "{}")
        : toolFunction.arguments || {};

    const isRoute = !!args.route;
    const inputLocations = Array.isArray(args.locations) ? args.locations : [];
    const language = args.language || "en";
    const region = args.region || "de";

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

    let street = "";
    const lastCoord = geo[geo.length - 1]?.coord;
    if (lastCoord) {
      const pano = buildStreetViewURL(lastCoord, language);
      street = `Street View: ${pano}\n`;
    }

    let directionsText = "";
    if (isRoute) {
      const origin = points[0];
      const destination = points[points.length - 1];
      const waypoints = points.slice(1, -1);
      directionsText = await getDirectionsText(origin, destination, waypoints, language);
    }

    return `${street}${isRoute ? "Route" : "Location"}: ${mapsUrl}\n\n${directionsText}`.trim();
  } catch (error) {
    console.error("getLocation error:", error?.message || error);
    return "[ERROR]: MAPS_UNEXPECTED — An unexpected error occurred while generating the map links.";
  }
}

module.exports = { getLocation };

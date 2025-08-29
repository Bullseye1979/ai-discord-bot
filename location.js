// location.js — clean v1.3
// Build Google Maps (route/pins) and optional Street View + human-readable directions.

const axios = require("axios");
const { getShortURL } = require("./helper.js");

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

/** URL-encode path segments for Maps. */
function joinForMaps(parts) {
  return parts.map((p) => encodeURIComponent(p)).join("/");
}

/** Geocode one query into { coord, address } or null. */
async function geocodeOne(query, { language = "en", region = "de" } = {}) {
  const q = normalize(query);
  if (!q) return null;
  if (isLatLon(q)) {
    const [lat, lng] = q.split(",").map((x) => x.trim());
    return { coord: `${lat},${lng}`, address: q };
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
    const { geometry, formatted_address } = results[0];
    const lat = geometry?.location?.lat;
    const lng = geometry?.location?.lng;
    if (typeof lat !== "number" || typeof lng !== "number") return null;
    return { coord: `${lat},${lng}`, address: formatted_address || q };
  } catch (e) {
    console.error("[getLocation][geocode] error:", e?.response?.data || e?.message || e);
    return null;
  }
}

/** Build Maps URL (route or search). */
function buildMapsURL(points, isRoute) {
  const base = isRoute ? "https://www.google.com/maps/dir/" : "https://www.google.com/maps/search/";
  return base + joinForMaps(points);
}

/** Build Street View image URL for a coordinate. */
function buildStreetViewURL(latLon) {
  return `https://maps.googleapis.com/maps/api/streetview?size=600x400&location=${latLon}&key=${GOOGLE_MAPS_API_KEY}`;
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

    const geo = await Promise.all(normalized.map((s) => geocodeOne(s, { language, region })));
    const points = normalized.map((txt, i) => geo[i]?.coord || txt);

    const minNeeded = isRoute ? 2 : 1;
    if (points.length < minNeeded) {
      return "[ERROR]: MAPS_INPUT — Not enough valid locations for the requested mode.";
    }

    const longMapUrl = buildMapsURL(points, isRoute);
    const shortMapUrl = await getShortURL(longMapUrl).catch(() => longMapUrl);

    let street = "";
    const lastCoord = geo[geo.length - 1]?.coord;
    if (lastCoord) {
      const longSV = buildStreetViewURL(lastCoord);
      const shortSV = await getShortURL(longSV).catch(() => longSV);
      street = `Street View: ${shortSV}\n`;
    }

    let directionsText = "";
    if (isRoute) {
      const origin = points[0];
      const destination = points[points.length - 1];
      const waypoints = points.slice(1, -1);
      directionsText = await getDirectionsText(origin, destination, waypoints, language);
    }

    return `${street}${isRoute ? "Route" : "Location"}: ${shortMapUrl}\n\n${directionsText}`.trim();
  } catch (error) {
    console.error("getLocation error:", error?.message || error);
    return "[ERROR]: MAPS_UNEXPECTED — An unexpected error occurred while generating the map links.";
  }
}

module.exports = { getLocation };

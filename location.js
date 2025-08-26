// location.js — v1.2 robust
// Returns a link to a route or a location on Google Maps + optional directions text
// Needs: GOOGLE_MAPS_API_KEY in env

const axios = require("axios");
const { getShortURL } = require("./helper.js");
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// -------- helpers --------
function getIsLatLon(input) {
  return /^\s*-?\d{1,2}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*$/.test(String(input || ""));
}
function norm(s) {
  return String(s || "")
    .trim()
    .replace(/^[,;]+|[,;]+$/g, "")   // führende/nachgestellte Kommas/Strichpunkte weg
    .replace(/\s{2,}/g, " ");        // doppelte Spaces
}
function safeJoinForMaps(parts) {
  // Für Maps-URL dürfen Freitext-Adressen stehenbleiben
  return parts.map(p => encodeURIComponent(p)).join("/");
}

async function geocodeOne(query, { language = "de", region = "de" } = {}) {
  const q = norm(query);
  if (!q) return null;
  if (getIsLatLon(q)) {
    const [lat, lng] = q.split(",").map(x => x.trim());
    return { coord: `${lat},${lng}`, address: q };
  }
  try {
    const resp = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: { address: q, key: GOOGLE_MAPS_API_KEY, language, region }
    });
    const { status, results, error_message } = resp.data || {};
    if (status !== "OK") {
      console.error(`[getLocation][geocode] status=${status} msg=${error_message || "-" } for "${q}"`);
      return null;
    }
    if (!Array.isArray(results) || !results.length) return null;
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

async function getGoogleMapsURL(points, isRoute) {
  const base = isRoute ? "https://www.google.com/maps/dir/" : "https://www.google.com/maps/search/";
  return base + safeJoinForMaps(points);
}

async function getStreetViewURL(latLon) {
  return `https://maps.googleapis.com/maps/api/streetview?size=600x400&location=${latLon}&key=${GOOGLE_MAPS_API_KEY}`;
}

async function getDirectionsText(origin, destination, waypoints = []) {
  try {
    const params = {
      origin, destination,
      mode: "driving",
      key: GOOGLE_MAPS_API_KEY,
      language: "de"
    };
    if (waypoints.length) params.waypoints = waypoints.join("|");
    const resp = await axios.get("https://maps.googleapis.com/maps/api/directions/json", { params });
    const { status, routes, error_message } = resp.data || {};
    if (status !== "OK") {
      console.error("[getLocation][directions] status=", status, "msg=", error_message);
      return "No directions found.";
    }
    if (!routes?.length) return "No directions found.";
    const steps = routes[0].legs.flatMap(leg => leg.steps.map(s => s.html_instructions));
    const textSteps = steps.map((s, i) => `${i + 1}. ${String(s || "").replace(/<[^>]+>/g, "")}`);
    return textSteps.join("\n");
  } catch (e) {
    console.error("[getLocation][directions] error:", e?.response?.data || e?.message || e);
    return "No directions found.";
  }
}

// -------- main tool --------
async function getLocation(toolFunction) {
  try {
    if (!GOOGLE_MAPS_API_KEY) {
      console.error("❌ getLocation: Missing GOOGLE_MAPS_API_KEY");
      return "Google Maps API key missing on server.";
    }

    const args = typeof toolFunction.arguments === "string"
      ? JSON.parse(toolFunction.arguments || "{}")
      : (toolFunction.arguments || {});
    const isRoute = !!args.route;
    const inputLocations = Array.isArray(args.locations) ? args.locations : [];
    const language = args.language || "de";
    const region = args.region || "de";

    if (!inputLocations.length) throw new Error("No locations provided.");

    // 1) normalisieren
    const normalized = inputLocations.map(norm).filter(Boolean);

    // 2) geokodieren (best effort)
    const geo = await Promise.all(normalized.map(s => geocodeOne(s, { language, region })));

    // 3) Für Maps/Directions Punkte bauen: Koordinate wenn vorhanden, sonst Freitext
    const points = normalized.map((txt, i) => (geo[i]?.coord || txt));

    // Mindestanzahl prüfen (aber *nicht* nur auf Koordinaten beschränken)
    const minNeeded = isRoute ? 2 : 1;
    if (points.length < minNeeded) throw new Error("Not enough valid locations.");

    // 4) URLs bauen
    const longMapUrl = await getGoogleMapsURL(points, isRoute);
    const shortMapUrl = await getShortURL(longMapUrl).catch(() => longMapUrl);

    // 5) StreetView (nur wenn Ziel Koordinaten hat)
    let street = "";
    const lastCoord = geo[geo.length - 1]?.coord;
    if (lastCoord) {
      const longSV = await getStreetViewURL(lastCoord);
      const shortSV = await getShortURL(longSV).catch(() => longSV);
      street = `Streetview: ${shortSV}\n`;
    }

    // 6) Directions (Strings sind erlaubt – Google geokodiert intern)
    let directionsText = "";
    if (isRoute) {
      const origin = points[0];
      const destination = points[points.length - 1];
      const waypoints = points.slice(1, -1);
      directionsText = await getDirectionsText(origin, destination, waypoints);
    }

    return `${street}${isRoute ? "Route" : "Location"}: ${shortMapUrl}\n\n${directionsText}`.trim();
  } catch (error) {
    console.error("❌ getLocation Error:", error?.message || error);
    return "An error occurred while generating the map links.";
  }
}

module.exports = { getLocation };

// Version 1.1
// Returns a link to a route or a location on google maps + directions as text

const axios = require("axios");
const { getShortURL } = require('./helper.js');
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;


// Check whether the input is coordinates

function getIsLatLon(input) {
    return /^-?\d{1,2}\.\d+,-?\d{1,3}\.\d+$/.test(input.trim());
}


// Get coordinates for location

async function getCoordinates(location) {
    if (getIsLatLon(location)) return location;
    const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
        params: { address: location, key: GOOGLE_MAPS_API_KEY }
    });
    if (!response.data.results.length) return null;
    const { lat, lng } = response.data.results[0].geometry.location;
    return `${lat},${lng}`;
}


// Get the URL for the google maps map

async function getGoogleMapsURL(locations, isRoute) {
    const base = isRoute ? 'https://www.google.com/maps/dir/' : 'https://www.google.com/maps/search/';
    return base + locations.map(encodeURIComponent).join('/');
}


// Get the URL for the streetview picture

async function getStreetViewURL(latLon) {
    return `https://maps.googleapis.com/maps/api/streetview?size=600x400&location=${latLon}&key=${GOOGLE_MAPS_API_KEY}`;
}


// Get textual directions using Google Directions API

async function getDirectionsText(origin, destination, waypoints = []) {
    const params = {
        origin,
        destination,
        key: GOOGLE_MAPS_API_KEY,
        mode: 'driving'
    };
    if (waypoints.length) {
        params.waypoints = waypoints.join('|');
    }
    const response = await axios.get('https://maps.googleapis.com/maps/api/directions/json', { params });
    if (!response.data.routes.length) return 'No directions found.';
    const steps = response.data.routes[0].legs.flatMap(leg => leg.steps.map(step => step.html_instructions));
    const textSteps = steps.map((s, i) => `${i + 1}. ${s.replace(/<[^>]+>/g, '')}`); // remove HTML tags

    return textSteps.join('\n');
}


// Generate a map based on the user's parameters

async function getLocation(toolFunction) {
    try {
        const args = JSON.parse(toolFunction.arguments);
        const isRoute = args.route;
        const inputLocations = args.locations;

        if (!inputLocations || inputLocations.length === 0) {
            throw new Error('No locations provided.');
        }
        const locationsLimited = inputLocations.slice(0, 10);
        const coords = await Promise.all(locationsLimited.map(getCoordinates));
        const validCoords = coords.filter(Boolean);

        if (validCoords.length < (isRoute ? 2 : 1)) {
            throw new Error('Not enough valid locations.');
        }
        const lastCoord = validCoords[validCoords.length - 1];
        const longMapUrl = await getGoogleMapsURL(validCoords, isRoute);
        const longStreetViewUrl = await getStreetViewURL(lastCoord);

        const [shortMapUrl, shortStreetViewUrl] = await Promise.all([
            getShortURL(longMapUrl),
            getShortURL(longStreetViewUrl)
        ]);
        let directionsText = '';
        if (isRoute) {
            const origin = validCoords[0];
            const destination = validCoords[validCoords.length - 1];
            const waypoints = validCoords.slice(1, -1);
            directionsText = await getDirectionsText(origin, destination, waypoints);
        }
        return `Streetview: ${shortStreetViewUrl}\n${isRoute ? 'Route' : 'Location'}: ${shortMapUrl}\n\n${directionsText}`;
    } catch (error) {
        console.error('❌ getLocation Error:', error.message);
        return 'An error occurred while generating the map links.';
    }
}


// Exports

module.exports = { getLocation };

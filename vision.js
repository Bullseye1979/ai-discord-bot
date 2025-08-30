// vision.js — refactored v1.1
// Analyze an image via Vision model and return a detailed description.

const { getDescription } = require("./aiService.js");
const { reportError } = require("./error.js");

/**
 * Tool entry: Analyze an image URL and return a detailed description.
 * Expected toolFunction.arguments with { image_url, user_id }.
 */
async function getImageDescription(toolFunction, _ctx = null, _getAIResponse = null, runtime = {}) {
  try {
    const args =
      typeof toolFunction.arguments === "string"
        ? JSON.parse(toolFunction.arguments || "{}")
        : toolFunction.arguments || {};

    const userId = String(args.user_id || runtime.user_id || "user");
    const imageUrl = String(args.image_url || "").trim();

    if (!imageUrl) {
      return "[ERROR]: VISION_INPUT — Missing 'image_url'.";
    }

    const prompt =
      "Describe the image in as much detail as possible. Extract any visible text, if present.";
    return await getDescription(imageUrl, prompt);
  } catch (err) {
    await reportError(err, runtime?.channel || null, "VISION_ANALYZE", "ERROR");
    return "[ERROR]: VISION_UNAVAILABLE — Could not analyze the image.";
  }
}

module.exports = { getImageDescription };

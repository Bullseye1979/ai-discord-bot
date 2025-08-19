// Version 1.1 (bereinigt)
// Manages the tools that are available to the AI

// Requirements
const { getWebpage } = require('./webpage.js');
const { getImage } = require('./image.js');
const { getGoogle } = require('./google');
const { getYoutube } = require('./youtube');
const { getImageDescription } = require('./vision.js');
const { getLocation } = require('./location');
const { getPDF } = require('./pdf.js');

// Tool Definitions
const tools = [
    {
        type: "function",
        function: {
            name: "getWebpage",
            description: "Fetches a webpages, removes menus, ads, scripts, and HTML, and returns the cleaned text.",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "Full URL of the webpage to be cleaned." },
                    user_id: { type: "string", description: "User ID or name who triggered the request." },
                },
                required: ["url", "user_id"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "getImage",
            description: "Generates a high-quality image based on a detailed description. Default size is 1024x1024 if not specified. Don't run this, when the same document is created by another tool_call. Only use it, when you intend to show the image or use it otherwise.",
            parameters: {
                type: "object",
                properties: {
                    prompt: { 
                        type: "string", 
                        description: "Prompt, that contains the basic required visual information about the image. Please note, that the function itself adds artistic choices." 
                    },
                    size: { 
                        type: "string", 
                        description: "Desired image size. If not specified, this field should not be set.", 
                        enum: ["1024x1024", "1792x1024", "1024x1792"] 
                    },
                    user_id: { 
                        type: "string", 
                        description: "User ID or name requesting the image." 
                    }
                },
                required: ["prompt", "user_id"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "getGoogle",
            description: "Performs a Google search and returns relevant results. Use it whenever you are asked for things you do not know, or current topics.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search term for Google search." },
                    user_id: { type: "string", description: "User ID who initiated the search." }
                },
                required: ["query", "user_id"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "getYoutube",
            description: "Analyzes YouTube Subtitles. Summarizes. Returns a list of blocks with timestamps and applies the prompt for each block indivicually.",
            parameters: {
                type: "object",
                properties: {
                    video_url: { type: "string", description: "URL of the YouTube video to be summarized." },
                    user_id: { type: "string", description: "User ID or name requesting the summary." },
                    user_prompt: { type: "string", description: "The original user prompt" }
                },
                required: ["video_url", "user_id", "user_prompt"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "getImageDescription",
            description: "Analyzes an image and provides a detailed description. Supports external URLs and Discord-uploaded images. This tool is required, when you want to recreate images.",
            parameters: {
                type: "object",
                properties: {
                    image_url: { 
                        type: "string", 
                        description: "The URL of the image to analyze. Supports direct links and Discord CDN image URLs (e.g., images uploaded in chat)." 
                    },
                    user_id: { 
                        type: "string", 
                        description: "The ID of the user requesting the image analysis."
                    },
                },
                required: ["image_url", "user_id"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "getLocation",
            description: "Use it, whenever you're asked for a location. Handles location-based tasks, including generating a route between multiple locations or setting location pins without a route. Returns 2 URLs one to the map and one to the streetview picture, as well as the textual description. Always show both links in your answer.",
            parameters: {
                type: "object",
                properties: {
                    locations: { 
                        type: "array", 
                        description: "List of locations to process. Must have at least two locations if a route is requested, otherwise single locations are allowed for pin placement.",
                        items: { type: "string" }
                    },
                    user_id: { 
                        type: "string", 
                        description: "User ID requesting the operation." 
                    },
                    route: {
                        type: "boolean", 
                        description: "Set to `true` to generate a step-by-step route between locations. Set to `false` to place location pins without a route."
                    }
                },
                required: ["locations", "user_id", "route"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "getPDF",
            description: "Generates a fully formatted PDF document based on a given original user prompt. Immediately create a PDF based on the user's prompt. This must be the first and only tool_call for PDF generation. Do not generate or run any other tool_calls before this one. It internally manages image generation and content rendering.",
            parameters: {
                type: "object",
                properties: {
                    prompt: {
                        type: "string",
                        description: "Full prompt/instructions for the PDF content."
                    },
                    original_prompt: {
                        type: "string",
                        description: "The user's original natural-language request."
                    },
                    user_id: {
                        type: "string",
                        description: "The ID of the user requesting the document."
                    }
                },
                required: ["prompt", "original_prompt", "user_id"]
            },
        }
    }
];

// Tool Registry
const fullToolRegistry = {
    getWebpage,
    getImage,
    getGoogle,
    getYoutube,
    getImageDescription,
    getLocation,
    getPDF
};


function getToolRegistry(toolNames = []) {
    if (!Array.isArray(toolNames)) {
        throw new Error("getToolRegistry erwartet ein Array von Toolnamen.");
    }

    const filteredTools = tools.filter(t => toolNames.includes(t.function.name));
    const registry = {};

    for (const name of toolNames) {
        if (fullToolRegistry[name]) {
            registry[name] = fullToolRegistry[name];
        }
    }

    return {
        tools: filteredTools,
        registry
    };
}

// Exports
module.exports = { getToolRegistry };

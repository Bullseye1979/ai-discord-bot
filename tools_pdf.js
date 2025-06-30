// Version 1.0
// Manages the tools that are available to the AI


// Requirements

const { getWebpage } = require('./webpage.js');
const { getImage } = require('./image.js');
const { getGoogle } = require('./google');
const { getYoutube } = require('./youtube');
const { getLocation } = require('./location');



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
                    user_prompt: {type: "string", description:"The original user prompt"}
                },
                required: ["video_url", "user_id", "user_prompt"]
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
    }

];


// Tool Registry

const getToolRegistry = () => {
    return {
        getWebpage,
        getImage,
        getGoogle,
        getYoutube,
        getLocation,
    };
};


// Exports

module.exports = { tools, getToolRegistry };

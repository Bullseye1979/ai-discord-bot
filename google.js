// Version 1.0
// Uses google search to find information


// Requirements

const axios = require("axios");


// Functions

async function getGoogle(toolFunction) {
    let userId;
    try {
        const args = JSON.parse(toolFunction.arguments);
        userId = args.user_id;
        const query = args.query;
        const response = await axios.get("https://www.googleapis.com/customsearch/v1", {
            params: {
                key: process.env.GOOGLE_API_KEY,
                cx: process.env.GOOGLE_CSE_ID,
                q: query,
                num: 5 
            }
        });
        const results = response.data.items?.map(item => ({
            title: item.title,
            snippet: item.snippet,
            link: item.link
        })) || [];

        if (results.length === 0) {
            return "[Error] No relevant search results found.";
        }
        return results.map(r => `${r.title}\n${r.snippet}\n${r.link}`).join("\n\n");
    } catch (error) {
        console.error(`[ERROR]:`, error);
        return "[Error] Unable to retrieve search results.";
    }
}

module.exports = { getGoogle };
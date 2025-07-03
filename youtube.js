// Version: 1.0
// Get the subtitles from YouTube videos and process them with AI
// Test
// Configuration

const MAX_TOKENS_PER_CHUNK = 2000; 

// Requirements

const { getSubtitles } = require("youtube-captions-scraper");
const { getAI } = require('./aiService.js');
const Context = require('./context');
const analysisContext = new Context();

// Functions


// Function to process the youtube video

async function getYoutube(toolFunction) {
    let userId;
    let userPrompt;
    try {
        const args = JSON.parse(toolFunction.arguments);
        userId = args.user_id;
        const videoUrl = args.video_url;
        userPrompt = args.user_prompt; // Benutzerfrage
        const videoId = new URL(videoUrl).searchParams.get("v");
        if (!videoId) {
             return "[Error] Unable to extract YouTube video ID.";
        }
        const transcript = await getSubtitles({ videoID: videoId, lang: "en" });
        if (!transcript || transcript.length === 0) {
               return "[Error] No transcript found for this video.";
        }
        const textChunks = getChunks(transcript, MAX_TOKENS_PER_CHUNK);
        let results = [];
        const analysisContext = new Context(); // wichtig: Frischen Context pro Run!
        for (let i = 0; i < textChunks.length; i++) {
            const { timestamp, text } = textChunks[i];
            await analysisContext.add(
                "user",
                "Instruction",
                `Based on the user's request: "${userPrompt}", summarize or condense the current section (${timestamp}): ${text} in the context of the entire conversation so far. Be concise, cumulative and structured.`
            );
            const result = await getAI(analysisContext, 100,"gpt-3.5-turbo");
            if (!result) {
                continue;
            } else  {
                results.push(`[${timestamp}] ${result}`);
                await analysisContext.add("assistant", "GPT", result);
            }
        }
        return results.join("\n");
    } catch (error) {
        console.error("[ERROR]: "+error);
        return "[Error] Unable to process the video.";
    }
}

// Function to split the subtitles in equaly sized chunks to process them

function getChunks(transcript, maxTokensPerChunk) {
    let chunks = [];
    let currentChunk = { timestamp: null, text: "", tokenCount: 0 };
    for (let entry of transcript) {
        const tokenCount = entry.text.split(" ").length; // Tokenanzahl schätzen
        if (!currentChunk.timestamp) {
            currentChunk.timestamp = getTimestamp(entry.start);
        }
        if (currentChunk.tokenCount + tokenCount > maxTokensPerChunk) {
            chunks.push(currentChunk);
            currentChunk = { timestamp: getTimestamp(entry.start), text: entry.text, tokenCount };
        } else {
            currentChunk.text += " " + entry.text;
            currentChunk.tokenCount += tokenCount;
        }
    }
    if (currentChunk.text) {
        chunks.push(currentChunk);
    }
    return chunks;
}

// Function to convert seconds in human radable timestamps

function getTimestamp(seconds) {
    const h = Math.floor(seconds / 3600).toString().padStart(2, "0");
    const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
    const s = Math.floor(seconds % 60).toString().padStart(2, "0");
    return `${h}:${m}:${s}`;
}


// Exports

module.exports = { getYoutube };

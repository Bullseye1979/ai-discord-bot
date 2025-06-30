// Version 1.0
// Provide various, small, helpful tools for reusing


// Requirements

const axios = require("axios");
const fs = require('fs/promises');
const { createAudioPlayer, createAudioResource, joinVoiceChannel, getVoiceConnection } = require("@discordjs/voice");
require('dotenv').config();


// Functions


// Shorten an URL by using tinyurl.com

async function getShortURL(longUrl) {
    try {
        const response = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`);
        return response.data;
    } catch (error) {
        return longUrl;
    }
}


// Deletes a file

async function getSafeDelete(filePath) {
    try {
        await fs.unlink(filePath);
    } catch (err) {
        if (err.code === "ENOENT") {
            console.warn(`[ERROR] File not found ( ${filePath} )`);
        } else {
            console.error(`[ERROR]: `, err);
        }
    }
}


// Clean up HTML and trim the output

function getPlainFromHTML(input, maxLength = 2000) {
    if (!input) return "";
    const withoutHTML = input.replace(/<[^>]*>?/gm, '');
    return withoutHTML.slice(0, maxLength);
}

module.exports = { getShortURL, getSafeDelete, getPlainFromHTML };
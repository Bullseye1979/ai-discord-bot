// Version 1.0
// Improve the prompt for an image and generate it. Return it as an URL


// Requirements

const { getAI, getAIImage } = require("./aiService.js");
const axios = require("axios");
const { getShortURL } = require("./helper.js");
const Context = require('./context.js');
const { IMAGEPROMPT } = require('./config.js');


// Functions

// Improve the promt and generate the image

async function getImage(toolFunction) {
    try {
        const args = JSON.parse(toolFunction.arguments);
        const userId = args.user_id;
        const context = new Context();
        context.add("system", userId, IMAGEPROMPT);
        context.add("user", userId, `Original image description: \"${args.prompt}\"`);
        const gptResponse = await getAI(context, 500, "gpt-4o");
        const improvedPrompt = gptResponse.trim();
        if (!improvedPrompt) throw new Error("[ERROR]: Could not improve prompt");
        const imageUrl = await getAIImage(improvedPrompt, args.size);
        if (!imageUrl) {
            throw new Error("[ERROR]: No picture received");
        }
        const url = await getShortURL(imageUrl);
        return url + "\n\n Prompt:" + improvedPrompt;
    } catch (error) {
        return "[ERROR]: Image could not be generated";
    } 
}

// Exports

module.exports = { getImage };

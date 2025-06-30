// Version 1.0
// Analyzes an image and returns a description


// Requirements

const { getDescription } = require('./aiService.js');


// Function

// Analyze the picture with Vision and return the result

async function getImageDescription(toolFunction) {
    let userId, imageUrl, query;
    const args = JSON.parse(toolFunction.arguments);
    userId = args.user_id;
    imageUrl = args.image_url;
    prompt = "Describe the image in as much detail as possible. Extract text, if there is any."; 
    return getDescription(imageUrl,prompt);
}


// Export

module.exports = { getImageDescription };

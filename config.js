// NAME: Regular name of the Bot, that also triggers it in voice chats.

const NAME ="Jenny";

module.exports = {

// MAX_QUEUE_SIZE: Maximum number of parallel requests to the AI

    MAX_QUEUE_SIZE: 3, 

// SUMARIZE_THERESHOLD: After how many messages should the contexte be sumarized to save space. The higher the number the higher the long term memory, but pricier.

    SUMMARIZE_THRESHOLD: 30,

// OPENAI_API_URL: Specifies the Endpoint to which the requests should be sent

    OPENAI_API_URL: "https://api.openai.com/v1/chat/completions",

// CHATTRIGGER: Command in the chat, that triggers the AI

    CHATTRIGGER: "!jenny",
    NAME,

// Voice of the Bot
    
    VOICE: "nova",

// IMAGEPROMPT: Instructions on how to improve images

    IMAGEPROMPT: `Enhance the following image description for DALL·E by making it more detailed, atmospheric, and creative without changing its original style.
                    - Use creative dynamic angles, lighting effects, and filters when appropriate.
                    - Incorporate creative symbolism when relevant.
                    - Give faces character and avoid generic or doll-like appearances.
                    - Use vibrant colors, when appropriate.
                    - Prefer digital art style.
                    - Prefer dynamic action-packed scenes, when appropriate.
                    - Ensure that each hand only has 5 fingers. Persons only have 2 arms and 2 legs. Avoid deformed faces and bodies.
                    - Ensure descriptions are not inappropriate or suggestive in any way.`
};

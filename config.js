// config.js — clean v1.1
// Central configuration for bot behavior and AI defaults.

module.exports = {
  OPENAI_API_URL: "https://api.openai.com/v1/chat/completions",
  IMAGEPROMPT: `Enhance the following image description for DALL·E by making it more detailed, atmospheric, and creative without changing its original style.
- Use creative dynamic angles, lighting effects, and filters when appropriate.
- Incorporate creative symbolism when relevant.
- Give faces character and avoid generic or doll-like appearances.
- Use vibrant colors, when appropriate.
- Prefer digital art style.
- Prefer dynamic action-packed scenes, when appropriate.
- Ensure that each hand only has 5 fingers. Persons only have 2 arms and 2 legs. Avoid deformed faces and bodies.
- Ensure descriptions are not inappropriate or suggestive in any way.
- No Text`
};

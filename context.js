// Version 1.0
// Provides an object for the context

// Requirements

const { SUMMARIZE_THRESHOLD } = require('./config');
const axios = require("axios");
const persona = null;
const instructions = null;
const tools = null;
const toolRegistry = null;


//Class

class Context {

    // Constructor

    constructor(persona_arg, instructions_arg, tools_arg, toolRegistry_arg) {
        this.messages = [];
        this.isSummarizing = false;
        this.persona = persona_arg;
        this.instructions = instructions_arg;
        this.add("system","",this.persona+"\n"+this.instructions);
        this.tools = tools_arg;
        this.toolRegistry = toolRegistry_arg;
    }


    // Add a new standard context entry

    async add(role, sender, message) {
        const safeName = (sender || "system")
            .toLowerCase()
            .replace(/\s+/g, "_")             // Leerzeichen → Unterstrich
            .replace(/[^a-z0-9_]/gi, "")      // nur a-z, 0-9, _
            .slice(0, 64);                    // maximal 64 Zeichen

        const formattedMessage = {
            role: role,
            content: message,
            name: safeName
        };

        this.messages.push(formattedMessage);

        const tokenLimit = 15000;
        const estimatedTokens = this.messages.reduce((sum, msg) => {
            const messageLength = msg.content ? msg.content.length : 0;
            return sum + Math.ceil(messageLength / 4);
        }, 0);

        if (
            this.messages.length > SUMMARIZE_THRESHOLD * 2 ||
            estimatedTokens > tokenLimit * 0.8
        ) {
            await this.summarize();
        }

        return formattedMessage;
    }



    // Ensure that the context is compressed

    async summarize() {
        if (this.isSummarizing) {
            return this.messages;
        }

        this.isSummarizing = true;
        try {
            if (this.messages.length < 4) {
                this.isSummarizing = false;
                return this.messages;
            }
            const midpoint = Math.floor(this.messages.length / 2);
            const oldMessages = this.messages.slice(0, midpoint);
            const newMessages = this.messages.slice(midpoint);
            const response = await axios.post("https://api.openai.com/v1/chat/completions", {
                model: "gpt-4-turbo",
                messages: [
                    {
                        role: "system",
                        content: `Summarize the following chat history as compactly as possible:
                                  - Use the shortest possible phrasing, preferably in Mandarin (if appropriate).
                                  - Remove all irrelevant, redundant, and embellished content.
                                  - Goal: maximum information density in minimal space.`
                    },
                    {
                        role: "user",
                        content: `[BEGIN CONTEXT]\n${JSON.stringify(oldMessages)}\n[END CONTEXT]`
                    }
                ],
                temperature: 0.2,
                max_tokens: 1000
            }, {
                headers: {
                    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
                    "Content-Type": "application/json"
                }
            });
            if (!response.data.choices?.[0]?.message?.content) {
                console.error("[ERROR]:", response.data);
                return this.messages;
            }
            const summary = response.data.choices[0].message.content.trim();
            this.messages = [
                { role: "assistant", content: `Summary of the context:\n${summary}` },
                ...newMessages
            ];
            this.messages.unshift({ role: "system", content: this.persona+"\n"+this.instructions });
            return this.messages;
        } catch (error) {
            console.error("[ERROR]: Error during summarization:", error);
            return this.messages;
        } finally {
            this.isSummarizing = false;
        }
    }


    // Cuts the context in small chunks that are more digestable

    async getContextAsChunks() {
        const maxLength = 1900;
        const jsonMessages = this.messages.map(msg => ({
            role: msg.role,
            name: msg.name,
            content: msg.content
        }));

        const fullText = JSON.stringify(jsonMessages, null, 2);
        const chunks = [];
        for (let i = 0; i < fullText.length; i += maxLength) {
            chunks.push(fullText.slice(i, i + maxLength));
        }

        return chunks;
    }

}


// Exports

module.exports = Context;

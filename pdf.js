// Version 1.0
// Generate a PDF based on the user prompt and the context



// Requirements

const axios = require("axios");
const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs/promises");
const Context = require("./context");
const { getAIImage, getAI } = require("./aiService");
const { tools, getToolRegistry } = require("./tools_pdf.js");
const { getPlainFromHTML } = require("./helper.js");


// Functions


// Generate a HTML document to get the formatting and then make a PDF out of it, with a segmented approach to be able to generate PDFs larger than the token limit

async function getPDF(toolFunction, context, getAIResponse) {
    try {
        const { prompt, original_prompt, user_id } = JSON.parse(toolFunction.arguments);
        const generationContext = new Context(
            "You are a PDF generator that generates HTML code which will later be rendered as a PDF document.",
            `### Output Format:
                - Only output valid, complete HTML code inside the <body> (no <html> or <head>).
                - Use visually structured elements: headings, tables, paragraphs, lists, etc.
                - Be creative, use colors, fonts, styling elements, borders, images.
                - Never include explanations, comments, or markdown – only pure HTML.
                - Do not mention PDF, tools, or your role – just generate the HTML.
                - Do not include <body> and </body> in your response.
                - Do not mark segment endings in the text.
                - If not specified otherwise in the user prompt: Always generate as much text as possible and be as detailed as you can. The more text the better.
                - Do not describe that the document has more text – just generate it.

               ### Content Strategy:
                - Always generate the full content of a document, not just outlines or summaries.
                - Assume your output is the final version meant for publishing, not a draft or plan.
                - Fully write out the content as appropriate: for example, in stories or scripts, include complete scenes, actions, and dialogue; in reports, include all sections in full length and detail.
                - Do not describe what would be written – actually write it.
                - Avoid high-level overviews or condensed structures. Instead, write the full detailed version.
                - Always show, never tell.
                - Ensure consistency with the already generated content.
                - Avoid topic or context changes. Stick to the topic and the prompts.
                - Never include placeholders like "to be added later", "will be detailed further", or "see statblock below" – instead, write that content inline.
                - Never reference future sections. Instead, write them immediately and in full.
                - Never assume external documents or previous knowledge.
                - You must imagine the document will be printed and read without any access to other material or context. Everything must be self-contained and complete.
                - Use only the last user prompt to determine what content to generate.
                - Use prior context only if it contains relevant source material (e.g., story segments, data, previous chapters) that the last prompt directly refers to or builds upon.
                - Do not include unrelated or older content from the context unless it is clearly necessary to fulfill the current request.
                - Treat context as supporting material. If it includes usable text and the prompt asks you to summarize, continue, rewrite, or transform it, then do so.

                ### Segment Strategy:
                - Segments will be generated until the [FINISH] tag is set.
                - NEVER set [FINISH] unless:
                  - All requested content has been written out in full.
                  - All requrements from the prompt are met
                - Do not rely on the user to imagine or extend any part.
                - [FINISH] must be placed only once, after the **last** meaningful and complete block of HTML content in the last segment
                - [FINISH] has to be set only, when all segments are self-contained and together form a fully structured, detailed, and ready-to-use document.
                - Do not format [FINISH] as HTML. Do not wrap it in tags. Just output the plain text: [FINISH]
                - Only append [FINISH] on a new line, after the last HTML tag, with no other content on the same line.
                - Even when you reach your token limit, the document doesn't need to be finalized. Don't rush to conclude the document. If tasks are still open, just don't set [FINISH]

                ### Token Handling:
                - If the document is longer than 700 tokens, segment the output intelligently.
                - Do not end the text unnaturally (no artificial conclusions or summary sentences).
                - Do not use phrases like "to be continued", "continue", or similar.
                - Find a natural cut point (e.g. between two sections or tags), and end the segment cleanly.
                - Wait for the next segment request to continue.
                - Always assume that subsequent pages will follow and continue in the same style and structure.

                ### Images:
                - When you want to include an image, generate a complete and styled <img> tag.
                - You have two options for the image source (src):

                  1. If you have access to a valid image URL (from any source such as prompt, context, or tool results), use it directly:
                     Example: <img src="https://example.com/image.png" style="width:80%;">

                  2. If no image URL is available, but you want to include an image, use a natural-language description inside curly braces as a placeholder:
                     Example: <img src="{a man with a hat}" style="max-width:90%; border: 2px solid #ccc;">
                     These descriptions will later be replaced by generated image URLs.

                - Always write full and valid HTML <img> tags, including styling (e.g., width, margin, border) and optional alt text.
                - Do not mix real URLs and curly-brace placeholders inside the same src.
                - Do not escape the curly braces.
                - Do not use markdown or descriptive text outside of the <img> tag.`

        );

        const formattedContext = context.messages.map(
            m => `${m.role.toUpperCase()}:\n${m.content}`
        ).join('\n\n');
        generationContext.add("user", "", 
            "Original chat context. Use all relevant data from the context for the creation of the document:\n\n" +
            formattedContext + "\n\n" +
            "Original User Prompt:\n" + original_prompt
        );
        let fullHTML = "";
        let imagelist = "";
        let segmentCount = 0;
        let persistentToolMessages = [];
        while (true) {
            const segmentContext = new Context("You are a took to generate segments of an HTML file.", "", tools, getToolRegistry());
            segmentContext.messages = [...generationContext.messages];

            if (persistentToolMessages.length > 0) {
                const toolBlock = persistentToolMessages.map(m => m.content).join("\n\n");
                segmentContext.add("assistant", "", "### Tool Results (context for this document)\n\n" + toolBlock);
            }

            if (segmentCount > 0) {
                segmentContext.add("assistant", "", "### Previously Generated HTML Content\n\n" + fullHTML);
            }

            segmentContext.add("user", "", "Continue directly after the last valid segment. Add only new content. Maintain structure, style, and detail level.");

            const segmentHTML = await getAIResponse(segmentContext, 700, 1,"gpt-4-turbo");
            if (!segmentHTML || segmentHTML.length < 100) break;

            const newToolMessages = segmentContext.messages.filter(msg => msg.role === "tool");
            for (const msg of newToolMessages) {
                const alreadyIncluded = persistentToolMessages.find(m => m.tool_call_id === msg.tool_call_id);
                if (!alreadyIncluded) {
                    persistentToolMessages.push(msg);
                }
            }
            if (segmentHTML.includes("[FINISH]")) {
                fullHTML += segmentHTML.replace("[FINISH]", "");
                break;
            } else {
                fullHTML += segmentHTML;
            }

            segmentCount++;
        }
        const imagePlaceholders = [...fullHTML.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
        const imageMap = {};
        for (const prompt of imagePlaceholders) {
            try {
                const url = await getAIImage(prompt);
                imagelist = imagelist+"\n"+prompt+"  :  "+url;
                imageMap[prompt] = url;
            } catch (err) {
                console.warn(`[ERROR]: Could not generate image for: ${prompt}`);
            }
        }

        let htmlWithImages = fullHTML;

        for (const [desc, url] of Object.entries(imageMap)) {
            const escapedDesc = desc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // RegEx escapen
            const regex = new RegExp(`\\{\\s*${escapedDesc}\\s*\\}`, 'g');
            htmlWithImages = htmlWithImages.replace(regex, url);
        }

        const styledHtml = `<!DOCTYPE html>
        <html lang="de">
        <head>
            <meta charset="UTF-8">
            <style>
                @page { size: A4; margin: 2cm; }
                body { font-family: Arial, sans-serif; font-size: 12pt; line-height: 1.6; margin: 0; padding: 0; }
                h1, h2, h3 { margin-top: 1em; page-break-after: avoid; }
                p { text-align: justify; }
                img { max-width: 100%; height: auto; display: block; margin: 10px auto; page-break-inside: avoid; }
                table, tr, td, th { page-break-inside: avoid; }
                .content { padding: 2cm; }
                .page-break { page-break-before: always; }
            </style>
        </head>
        <body>
            <div class="content">
                ${htmlWithImages}
            </div>
        </body>
        </html>`;

        const request = new Context();
        request.add("user", "", `Generate a lowercase filename with maximum of 40 letters, only alphanumerical, no file extension at the end, for a file generated by the following prompts. Only return the filename, no remarks or comments:\n\n${original_prompt}\n\n${prompt}`);

        const fileName = await getAI(request,50,"gpt-3.5-turbo");
        const documentsDir = path.join(__dirname, "documents");
        await fs.mkdir(documentsDir, { recursive: true });
        const pdfPath = path.join(documentsDir, `${fileName}.pdf`);

        const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
        const page = await browser.newPage();
        await page.setContent(styledHtml, { waitUntil: "load" });
        await page.pdf({
            path: pdfPath,
            format: "A4",
            printBackground: true,
            displayHeaderFooter: true,
            footerTemplate: `<div style="width: 100%; text-align: center; font-size: 10pt; color: #888;">Generated by AI</div>`,
            margin: { top: "1cm", right: "1cm", bottom: "1.5cm", left: "1cm" }
        });

        await browser.close();
        return getPlainFromHTML(htmlWithImages,2000) + `\n\nPDF path: https://xbullseyegaming.de/documents/${fileName}.pdf` + "\n\n###Images:### \n"+imagelist;

    } catch (err) {
        console.error("[ERROR]: ", err);
        return "[ERROR]: Could not generate PDF";
    }
}

// Exports

module.exports = { getPDF };

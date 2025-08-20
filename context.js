// context.js
// Handles context storage and DB integration for messages and summaries

const mysql = require("mysql2/promise");

// Verbindung zur Datenbank
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

class Context {
    constructor(systemPrompt = null) {
        this.systemPrompt = systemPrompt;
        this.messages = [];
    }

    async init(channelId) {
        this.channelId = channelId;

        // Systemprompt zuerst
        if (this.systemPrompt) {
            this.messages.push({
                role: "system",
                sender: "system",
                content: this.systemPrompt,
                timestamp: new Date()
            });
        }

        // 5 letzte Summaries laden (älteste zuerst)
        const [rows] = await pool.query(
            `SELECT * FROM summaries WHERE channel_id = ? ORDER BY timestamp DESC LIMIT 5`,
            [channelId]
        );
        const summaries = rows.reverse();
        for (const row of summaries) {
            this.messages.push({
                role: "system",
                sender: "summary",
                content: row.content,
                timestamp: row.timestamp
            });
        }
    }

    async add(role, sender, content) {
        const message = {
            role,
            sender,
            content,
            timestamp: new Date(),
            channel_id: this.channelId
        };
        this.messages.push(message);

        // Nachricht in DB speichern
        await pool.query(
            `INSERT INTO messages (channel_id, role, sender, content, timestamp) VALUES (?, ?, ?, ?, ?)`,
            [this.channelId, role, sender, content, message.timestamp]
        );
    }

    async summarize(channel, aiFunc, summaryPrompt) {
        // Hinweis im Channel
        await channel.send("⚠️ Summary in progress, new messages will not be considered.");

        // Alle Messages des Channels (außer system + summaries) holen
        const [rows] = await pool.query(
            `SELECT * FROM messages WHERE channel_id = ? ORDER BY timestamp ASC`,
            [this.channelId]
        );

        if (rows.length === 0) {
            await channel.send("⚠️ No messages to summarize.");
            return;
        }

        // Kontext für die AI bauen
        const contextForAI = new Context();
        contextForAI.add("system", "system", summaryPrompt);
        for (const msg of rows) {
            contextForAI.add(msg.role, msg.sender, msg.content);
        }

        // AI fragen
        const summary = await aiFunc(contextForAI, 1000, 1);

        // Summary speichern
        await pool.query(
            `INSERT INTO summaries (channel_id, content, timestamp) VALUES (?, ?, ?)`,
            [this.channelId, summary, new Date()]
        );

        // Nachrichten im Channel löschen
        const fetched = await channel.messages.fetch({ limit: 100 });
        await channel.bulkDelete(fetched);

        // 5 letzte Summaries erneut laden
        const [sumRows] = await pool.query(
            `SELECT * FROM summaries WHERE channel_id = ? ORDER BY timestamp DESC LIMIT 5`,
            [this.channelId]
        );
        const summaries = sumRows.reverse();

        for (const s of summaries) {
            await channel.send(`📄 **Summary** (${s.timestamp.toISOString()}):\n${s.content}`);
        }

        // Hinweis fertig
        await channel.send("✅ Summary completed.");
    }
}

module.exports = Context;

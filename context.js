// Version 2.2
// Context-Management mit SQL-Speicherung (inkl. channelId) und ohne Summarizer

const mysql = require('mysql2/promise');
require('dotenv').config();

// --- MySQL Pool -------------------------------------------------------------
const pool = mysql.createPool({
    host: process.env.DB_HOST,       // z.B. 127.0.0.1
    user: process.env.DB_USER,       // z.B. bot_user
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,   // z.B. discord_ai
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ISO → MySQL DATETIME (UTC)
function toMySQLDateTime(date = new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    const yyyy = date.getUTCFullYear();
    const MM = pad(date.getUTCMonth() + 1);
    const dd = pad(date.getUTCDate());
    const hh = pad(date.getUTCHours());
    const mm = pad(date.getUTCMinutes());
    const ss = pad(date.getUTCSeconds());
    return `${yyyy}-${MM}-${dd} ${hh}:${mm}:${ss}`;
}

class Context {
    constructor(persona_arg, instructions_arg, tools_arg, toolRegistry_arg, channelId = "global") {
        this.messages = [];
        this.persona = persona_arg;
        this.instructions = instructions_arg;
        this.tools = tools_arg;
        this.toolRegistry = toolRegistry_arg;
        this.channelId = channelId;

        // Systemprompt als erste Nachricht
        const sys = `${this.persona || ""}\n${this.instructions || ""}`.trim();
        if (sys) {
            // bewusst awaited, damit SQL-Fehler geloggt würden, aber Flow weitergeht
            this.add("system", "system", sys);
        }
    }

    // Eintrag hinzufügen + in DB loggen
    async add(role, sender, message) {
        const safeName = (sender || "system")
            .toLowerCase()
            .replace(/\s+/g, "_")
            .replace(/[^a-z0-9_]/gi, "")
            .slice(0, 64);

        const now = new Date();
        const entry = {
            role,
            content: String(message ?? ""),
            name: safeName,
            timestamp: now.toISOString(),
            channelId: this.channelId
        };

        this.messages.push(entry);

        // Best-effort DB-Insert
        try {
            await pool.execute(
                `INSERT INTO context_log (timestamp, channel_id, role, sender, content) VALUES (?, ?, ?, ?, ?)`,
                [toMySQLDateTime(now), this.channelId, role, safeName, entry.content]
            );
        } catch (err) {
            console.error("[DB ERROR] Insert failed:", err.message);
        }

        return entry;
    }

    // Kontext als lesbare Blöcke zurückgeben (Debugging)
    async getContextAsChunks() {
        const maxLength = 1900;
        const jsonMessages = this.messages.map(m => ({
            role: m.role,
            name: m.name,
            timestamp: m.timestamp,
            channelId: m.channelId,
            content: m.content
        }));
        const full = JSON.stringify(jsonMessages, null, 2);
        const out = [];
        for (let i = 0; i < full.length; i += maxLength) {
            out.push(full.slice(i, i + maxLength));
        }
        return out;
    }
}

module.exports = Context;

// context.js — v4.9 (robust: safe name + always-memory + DB-optional)
// Nach !summarize: Kontext = System + 5 Summaries (älteste→neueste) + ALLE Einzel-Messages >= Cutoff

require("dotenv").config();
const mysql = require("mysql2/promise");
const { getAI } = require("./aiService.js");

let pool;

// --- Helpers ---------------------------------------------------------

function toMySQLDateTime(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}


// --- NEU ganz oben innerhalb der Datei (Hilfsfunktionen) ---------------------

function isSystem(msg) {
  return msg?.role === "system";
}
function isSummary(msg) {
  // Wir lassen "assistant" + name === "summary" als Summary gelten (kompatibel zu DB-Variante)
  return msg?.role === "assistant" && (msg?.name === "summary" || /^summary/i.test(msg?.name || ""));
}
function isUser(msg) {
  return msg?.role === "user";
}
function isAssistantToolCall(msg) {
  // assistant-message, die tool_calls enthält
  return msg?.role === "assistant" && Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
}
function isTool(msg) {
  return msg?.role === "tool";
}

// Gibt die Zahl der User-Messages (ohne system/summary) zurück
function countUsers(messages) {
  return messages.reduce((n, m) => n + (isUser(m) ? 1 : 0), 0);
}

// Zählt Tool-Paare (assistant(tool_calls) + folgendes tool)
function countToolPairs(messages) {
  let pairs = 0;
  for (let i = 0; i < messages.length - 1; i++) {
    if (isAssistantToolCall(messages[i]) && isTool(messages[i + 1])) {
      pairs++;
      i++; // das Paar überspringen
    }
  }
  return pairs;
}

// Entfernt sicher vom ANFANG Nachrichten – achtet darauf, dass Tool-Paare zusammen entfernt werden.
// removePredicate entscheidet, welche Kandidaten weg dürfen (z.B. nur user).
function shiftSafely(messages, removePredicate, howMany) {
  if (howMany <= 0) return 0;
  let removed = 0;
  // Index 0 ist (bei dir) immer System → den überspringen
  let i = 0;
  while (i < messages.length && removed < howMany) {
    const msg = messages[i];

    // System nie entfernen
    if (isSystem(msg)) { i++; continue; }

    // Summary i. d. R. behalten (kannst du optional erlauben zu löschen)
    if (isSummary(msg)) { i++; continue; }

    // Wenn es ein assistant tool_call ist und wir ihn löschen dürften,
    // dann MUSS direkt danach (falls vorhanden) auch die tool-msg mit weg.
    if (isAssistantToolCall(msg)) {
      // Tool-Paare nur löschen, wenn removePredicate beide zulässt
      const nextIsTool = i + 1 < messages.length && isTool(messages[i + 1]);
      if (removePredicate(msg)) {
        if (nextIsTool && removePredicate(messages[i + 1])) {
          messages.splice(i, 2);
          removed += 2;
          continue; // an gleicher Stelle weitermachen
        } else {
          // unvollständiges Paar nicht anrühren → weiter
          i++;
          continue;
        }
      } else {
        i++;
        continue;
      }
    }

    // Wenn es eine tool-Message ist, prüfen ob davor ein tool_call stand (ältester Teil eines Paares)
    if (isTool(msg)) {
      // Sicherheit: nur entfernen, wenn removePredicate erlaubt UND davor kein passender assistant(tool_calls) steht,
      // oder wenn er direkt davor steht und removePredicate auch den assistant löschen würde (Paar!)
      const prevIsAssistantToolCall = i - 1 >= 0 && isAssistantToolCall(messages[i - 1]);
      if (prevIsAssistantToolCall) {
        if (removePredicate(messages[i - 1]) && removePredicate(msg)) {
          // lösche das Paar von i-1 (assistant) und i (tool)
          messages.splice(i - 1, 2);
          removed += 2;
          // i zeigt nun auf den Eintrag, der nach dem gelöschten tool stand → nicht i++,
          // aber um die Schleife sauber zu halten:
          i = Math.max(0, i - 1);
          continue;
        } else {
          i++;
          continue;
        }
      } else {
        // Einzelne Tool-Message ohne Partner niemals löschen (sonst crasht Bot)
        i++;
        continue;
      }
    }

    // Normalfall (z.B. user/assistant ohne tools)
    if (removePredicate(msg)) {
      messages.splice(i, 1);
      removed += 1;
      continue;
    } else {
      i++;
    }
  }
  return removed;
}



/** Baut Blöcke: Ein Block beginnt mit einer user-Message und enthält ALLES bis zur nächsten user.
 *  Summaries werden separat gehalten; System bleibt unangetastet.
 */
function buildBlocks(messages) {
  const hasSystem = messages.length && isSystem(messages[0]);
  const headIdx = hasSystem ? 1 : 0;

  // Summaries isolieren (werden nicht getrimmt)
  const summaries = [];
  const body = [];
  for (let i = headIdx; i < messages.length; i++) {
    const m = messages[i];
    if (isSummary(m)) summaries.push(m);
    else body.push(m);
  }

  // Blöcke bilden
  const blocks = [];
  let cur = [];
  const flush = () => { if (cur.length) { blocks.push(cur); cur = []; } };

  for (const m of body) {
    if (isUser(m)) { flush(); cur = [m]; }
    else { cur.push(m); }
  }
  flush();

  return { headIdx, summaries, blocks };
}

/** Löscht die ältesten k User-Blöcke vollständig (inkl. assistant/tool, die darin liegen). */
function dropOldestUserBlocks(messages, k) {
  if (!k || k <= 0) return 0;

  const hasSystem = messages.length && isSystem(messages[0]);
  const headIdx = hasSystem ? 1 : 0;

  // Zerlegen
  const head = hasSystem ? [messages[0]] : [];
  const { summaries, blocks } = buildBlocks(messages);

  // Indizes der Blöcke, die eine user-Message enthalten
  const userBlockIdx = blocks
    .map((b, i) => ({ i, hasUser: b.some(isUser) }))
    .filter(x => x.hasUser)
    .map(x => x.i);

  if (!userBlockIdx.length) return 0;

  const toKill = Math.min(k, userBlockIdx.length);
  const killSet = new Set(userBlockIdx.slice(0, toKill)); // älteste zuerst

  const keptBlocks = blocks.filter((b, i) => !killSet.has(i));

  // Neu zusammensetzen: System + Summaries + verbleibende Blöcke
  const rebuilt = [
    ...head,
    ...summaries,
    ...keptBlocks.flat()
  ];

  messages.splice(0, messages.length, ...rebuilt);
  return toKill;
}





// OpenAI akzeptiert names nur mit regex: ^[^\s<|\\/>]+$
// Wir erlauben a–z, 0–9, _ und schneiden auf 64 Zeichen.
function sanitizeName(input, fallback = "user") {
  return String(input || fallback)
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/gi, "")
    .slice(0, 64) || fallback;
}

async function getPool() {
  if (!pool) {
    pool = await mysql.createPool({
      host: process.env.DB_HOST || "127.0.0.1",
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || process.env.DB_PASS || "",
      database: process.env.DB_NAME || process.env.DB_DATABASE,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      timezone: "Z",
      charset: "utf8mb4_general_ci",
    });
    await ensureTables(pool);
  }
  return pool;
}

async function ensureTables(pool) {
  const c = await pool.getConnection();
  try {
    await c.query(`
      CREATE TABLE IF NOT EXISTS context_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        timestamp DATETIME NOT NULL,
        channel_id VARCHAR(64) NOT NULL,
        role VARCHAR(50) NOT NULL,
        sender VARCHAR(64) NOT NULL,
        content MEDIUMTEXT NOT NULL,
        INDEX idx_ch_ts (channel_id, timestamp),
        INDEX idx_ch_id (channel_id, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await c.query(`
      CREATE TABLE IF NOT EXISTS summaries (
        id INT AUTO_INCREMENT PRIMARY KEY,
        timestamp DATETIME NOT NULL,
        channel_id VARCHAR(64) NOT NULL,
        summary MEDIUMTEXT NOT NULL,
        last_context_id INT NULL,
        INDEX idx_sum_ch_id (channel_id, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await c.query(`
      ALTER TABLE summaries
      ADD COLUMN IF NOT EXISTS last_context_id INT NULL;
    `).catch(() => {});
  } finally {
    c.release();
  }
}

// --- Context Class ---------------------------------------------------

class Context {
  constructor(persona = "", instructions = "", tools = [], toolRegistry = {}, channelId = "global", opts = {}) {
    const { skipInitialSummaries = false } = opts;
    this.messages = [];
    this.persona = persona || "";
    this.instructions = instructions || "";
    this.tools = tools || [];
    this.toolRegistry = toolRegistry || {};
    this.channelId = String(channelId);
    this.isSummarizing = false;
    this._maxUserMessages = null;   // z.B. aus Channel-Config
    this._maxToolPairs = null;      // optional

    const sys = `${this.persona}\n${this.instructions}`.trim();
    if (sys) {
      this.messages.push({ role: "system", name: "system", content: sys });
    }

    this._initLoaded = skipInitialSummaries ? Promise.resolve() : this._injectInitialSummaries();
  }



    // -- NEU: von außen (bot.js) setzbar: maximale Anzahl User-Elemente (Blöcke)
  setUserWindow(maxUserMessages, { prunePerTwoNonUser = true } = {}) {
    const n = Number(maxUserMessages);
    this._maxUserMessages = Number.isFinite(n) && n >= 0 ? n : null;
    this._prunePerTwoNonUser = !!prunePerTwoNonUser;
    this._nonUserSincePair = 0; // Zähler für "assistant(tool_call)+tool" -> danach 2 User-Blöcke entfernen

    this._enforceUserWindowCap?.();
  }

  /** Zählt aktuelle User-Blöcke (ohne system & summaries). */
  _countUserBlocks() {
    const { blocks } = buildBlocks(this.messages);
    return blocks.filter(b => b.some(isUser)).length;
  }

  /** Erzwingt das Fenster: max. _maxUserMessages User-Blöcke behalten (älteste zuerst entfernen). */
  _enforceUserWindowCap() {
    if (this._maxUserMessages == null) return;
    let have = this._countUserBlocks();
    if (have > this._maxUserMessages) {
      const diff = have - this._maxUserMessages;
      dropOldestUserBlocks(this.messages, diff);
    }
  }

  /** Wird nach jedem add() aufgerufen, um proportional zu trimmen:
   * - Wenn ein Tool-Paar fertig wurde (wir fangen es auf dem 'tool' an), entferne 2 User-Blöcke.
   * - Danach immer die harte Obergrenze (_maxUserMessages) durchsetzen.
   */
  _afterAddTrim(lastRole) {
    console.log("Trim started");
    if (this._maxUserMessages == null) return;
    console.log("Gate done");

    // 1) Paarlogik: Wenn gerade ein 'tool' hinzugefügt wurde und davor ein assistant(tool_calls) steht,
    //    gilt das als "2 Non-User-Elemente" -> entferne 2 User-Blöcke vom Anfang.
    const L = this.messages.length;
    if (L >= 2 && lastRole === "tool") {
      const prev = this.messages[L - 2];
      if (isAssistantToolCall(prev)) {
        dropOldestUserBlocks(this.messages, 2);
      }
    }

    // 2) Harte Cap immer zum Schluss sicherstellen
    this._enforceUserWindowCap();
  }


    /**
   * Reduziert den in‑memory Kontext auf:
   *   [ system, letzte_DB_Summary? ]
   * - System bleibt (Rolle nicht vergessen).
   * - Wenn es eine Summary gibt, wird genau EINE (die jüngste) injiziert.
   * - DB bleibt unverändert.
   */
  async collapseToSystemAndLastSummary() {
    // 1) System wiederherstellen
    const sys = `${this.persona}\n${this.instructions}`.trim();
    this.messages = sys ? [{ role: "system", name: "system", content: sys }] : [];

    // 2) Jüngste Summary aus DB holen
    try {
      const last = await this.getLastSummaries(1); // [{ id, timestamp, summary }] oder []
      const newest = last?.[0]?.summary;
      if (newest && newest.trim()) {
        this.messages.push({
          role: "assistant",
          name: "summary",
          content: newest.trim()
        });
      }
    } catch (e) {
      console.warn("[collapseToSystemAndLastSummary] failed:", e.message);
    }

    return this.messages;
  }


  async _injectInitialSummaries() {
    try {
      const db = await getPool();
      const [rowsDesc] = await db.execute(
        `SELECT timestamp, summary FROM summaries WHERE channel_id=? ORDER BY id DESC LIMIT 1`,
        [this.channelId]
      );
      if (!rowsDesc?.length) return;
      const asc = rowsDesc.slice().reverse();
      const head = this.messages[0]?.role === "system" ? 1 : 0;
      this.messages.splice(
        head,
        0,
        ...asc.map((r) => ({ role: "assistant", name: "summary", content: r.summary }))
      );
    } catch (e) {
      console.error("[DB] load initial summaries failed:", e.message);
    }
  }

  _rebuildSystemOnly() {
    const sys = `${this.persona}\n${this.instructions}`.trim();
    this.messages = sys ? [{ role: "system", name: "system", content: sys }] : [];
  }

    /**
   * Robustes add():
   * - Sanitized name (verhindert 400er).
   * - Schreibt IMMER erst in-memory.
   * - DB-Write best-effort (Fehler ≠ Verlust der Nachricht).
   * - Trimmt danach den RAM-Kontext gemäß Fenster (System & Summaries bleiben).
   */
  async add(role, sender, content, timestampMs = null, { alsoMemory = true } = {}) {
    const safeRole = String(role || "user");
    const safeName = sanitizeName(sender, safeRole === "system" ? "system" : "user");
    const safeContent = String(content ?? "");

    // 1) Sofort in-memory pushen (damit Tools ohne DB laufen).
    if (alsoMemory) {
      this.messages.push({ role: safeRole, name: safeName, content: safeContent });
    }

    // 2) DB-Write best-effort (nicht blockierend für Tools).
    try {
      const db = await getPool();
      const ts = toMySQLDateTime(timestampMs ? new Date(timestampMs) : new Date());
      await db.execute(
        `INSERT INTO context_log (timestamp, channel_id, role, sender, content)
         VALUES (?, ?, ?, ?, ?)`,
        [ts, this.channelId, safeRole, safeName, safeContent]
      );
    } catch (e) {
      console.warn("[DB][add] write failed (non-fatal):", e.message);
    }

    // 3) Nachführen des Fensters:
    //    - Tool-Paar → 2 User-Blöcke droppen
    //    - danach Cap durchsetzen
    if (alsoMemory) {
      this._afterAddTrim(safeRole);
    }

    return { role: safeRole, name: safeName, content: safeContent };
  }


  async getMessagesAfter(cutoffMs) {
    try {
      const db = await getPool();
      const [rows] = await db.execute(
        `SELECT timestamp, role, sender, content
           FROM context_log
          WHERE channel_id=? AND timestamp >= ?
          ORDER BY id ASC`,
        [this.channelId, toMySQLDateTime(new Date(cutoffMs))]
      );
      return rows || [];
    } catch (e) {
      console.warn("[DB][getMessagesAfter] read failed:", e.message);
      return [];
    }
  }

// context.js – summarizeSince (nur letzte Summary posten, Kontext unangetastet lassen)
async summarizeSince(cutoffMs, customPrompt = null) {
  if (this.isSummarizing) {
    return { messages: this.messages, lastSummary: null, insertedSummaryId: null, usedMaxContextId: null };
  }
  this.isSummarizing = true;

  // sehr nüchterner Fallback-Prompt (keine Halluzinationen)
  const DEFAULT_EXTRACTIVE_PROMPT = `
You are an EXTRACTIVE summarizer for chat logs.

Hard rules:
- Include only facts explicitly present in the SOURCE LINES.
- Do not invent names, places, or events. If unsure, omit.
- Each bullet MUST end with the source line IDs in square brackets, e.g. [#123,#128].
- If there are no in-character or otherwise valid events, output exactly: "No in-character events in this period."

Output:
- A short title.
- 3–10 bullet points, plain past tense, neutral tone (no purple prose).
`.trim();

  try {
    const db = await getPool();

    // Letzte Summary/Cursor laden
    const [lastSum] = await db.execute(
      `SELECT id, last_context_id FROM summaries WHERE channel_id=? ORDER BY id DESC LIMIT 1`,
      [this.channelId]
    );
    const lastCursor = lastSum?.[0]?.last_context_id ?? null;
    const cutoff = toMySQLDateTime(new Date(cutoffMs));

    // Kandidatenzeilen holen (nur eigener Channel!)
    let rows = [];
    if (lastCursor != null) {
      const [r] = await db.execute(
        `SELECT id, timestamp, role, sender, content
           FROM context_log
          WHERE channel_id=? AND id > ? AND timestamp <= ?
          ORDER BY id ASC`,
        [this.channelId, lastCursor, cutoff]
      );
      rows = r || [];
    } else {
      const [r] = await db.execute(
        `SELECT id, timestamp, role, sender, content
           FROM context_log
          WHERE channel_id=? AND timestamp <= ?
          ORDER BY id ASC`,
        [this.channelId, cutoff]
      );
      rows = r || [];
    }

    let maxId = rows.length ? rows[rows.length - 1].id : lastCursor;
    let insertedSummaryId = null;

    if (rows.length) {
      // Quelle kompakt + mit IDs aufbereiten (für Zitierpflicht)
      const text = rows
        .map(r => `[#${r.id}] ${r.role.toUpperCase()}(${r.sender}): ${r.content}`)
        .join("\n");

      // Prompt-Priorität: customPrompt > this.summaryPrompt (aus Channel-Config) > Default
      const prompt =
        (customPrompt && customPrompt.trim()) ||
        (this.summaryPrompt && this.summaryPrompt.trim()) ||
        DEFAULT_EXTRACTIVE_PROMPT;

      // isolierter Mini-Context nur für die Zusammenfassung
      const sumCtx = new Context(
        "You are a channel summary generator.",
        prompt,
        [], // keine Tools
        {}, // kein Tool-Registry
        this.channelId,
        { skipInitialSummaries: true } // wichtig: keine automatischen DB-Summaries reinziehen
      );

      // nur in-memory
      sumCtx.messages.push({ role: "user", name: "system", content: text });

      // Temperatur niedrig halten
      const summary = (await getAI(sumCtx, 900, "gpt-4-turbo", { temperature: 0.1 }))?.trim() || "";

      if (summary) {
        const [res] = await db.execute(
          `INSERT INTO summaries (timestamp, channel_id, summary, last_context_id)
           VALUES (?, ?, ?, ?)`,
          [toMySQLDateTime(new Date()), this.channelId, summary, maxId]
        );
        insertedSummaryId = res?.insertId ?? null;
      }
    } else {
      console.debug("[SUMMARY] No new rows since last cursor/cutoff.");
    }

    // ✅ Nur die zuletzt erzeugte Summary zurückgeben – Kontext NICHT verändern
    let lastSummary = null;
    if (insertedSummaryId) {
      const [rowsOne] = await db.execute(
        `SELECT summary FROM summaries WHERE id=?`,
        [insertedSummaryId]
      );
      lastSummary = rowsOne?.[0]?.summary || null;
    }

    return { messages: this.messages, lastSummary, insertedSummaryId, usedMaxContextId: maxId };
  } catch (e) {
    console.error("[SUMMARIZE] failed:", e);
    return { messages: this.messages, lastSummary: null, insertedSummaryId: null, usedMaxContextId: null };
  } finally {
    this.isSummarizing = false;
  }
}

  async getLastSummaries(limit = 1) {
    try {
      const db = await getPool();
      const [rows] = await db.execute(
        `SELECT id, timestamp, summary FROM summaries WHERE channel_id=? ORDER BY id DESC LIMIT ?`,
        [this.channelId, Number(limit)]
      );
      return rows || [];
    } catch (e) {
      console.warn("[DB][getLastSummaries] read failed:", e.message);
      return [];
    }
  }

  async getMaxContextId() {
    try {
      const db = await getPool();
      const [rows] = await db.execute(
        `SELECT MAX(id) AS maxId FROM context_log WHERE channel_id=?`,
        [this.channelId]
      );
      return rows?.[0]?.maxId ?? null;
    } catch (e) {
      console.warn("[DB][getMaxContextId] read failed:", e.message);
      return null;
    }
  }

  async bumpCursorToCurrentMax() {
    try {
      const db = await getPool();
      const maxId = await this.getMaxContextId();
      if (maxId == null) return null;
      await db.execute(
        `UPDATE summaries SET last_context_id=? WHERE channel_id=? ORDER BY id DESC LIMIT 1`,
        [maxId, this.channelId]
      );
      console.debug(`[SUMMARY][DEBUG] Cursor bumped to max context_log.id = ${maxId}`);
      return maxId;
    } catch (e) {
      console.error("[SUMMARY] bumpCursorToCurrentMax failed:", e.message);
      return null;
    }
  }

  async purgeChannelData() {
    try {
      const db = await getPool();
      const [r1] = await db.execute(`DELETE FROM context_log WHERE channel_id=?`, [this.channelId]);
      const [r2] = await db.execute(`DELETE FROM summaries WHERE channel_id=?`, [this.channelId]);
      this._rebuildSystemOnly();
      return {
        contextDeleted: r1?.affectedRows ?? 0,
        summariesDeleted: r2?.affectedRows ?? 0,
      };
    } catch (e) {
      console.error("[PURGE] failed:", e.message);
      this._rebuildSystemOnly();
      return { contextDeleted: 0, summariesDeleted: 0 };
    }
  }

  async getContextAsChunks() {
    const max = 1900;
    const full = JSON.stringify(
      this.messages.map((m) => ({ role: m.role, name: m.name, content: m.content })),
      null,
      2
    );
    const out = [];
    for (let i = 0; i < full.length; i += max) out.push(full.slice(i, i + max));
    return out;
  }
}

module.exports = Context;

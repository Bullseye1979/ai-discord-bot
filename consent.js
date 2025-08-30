// consent.js — refactored v1.1
// Channel-scoped consent storage per user_id × channel_id in MySQL.

const mysql = require("mysql2/promise");
const { reportError } = require("./error.js");

let pool = null;

/** Returns a shared MySQL pool and ensures the table exists once. */
async function getPool() {
  if (pool) return pool;
  try {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 5,
      charset: "utf8mb4",
    });
    await ensureTable(pool);
    return pool;
  } catch (err) {
    await reportError(err, null, "CONSENT_DB_POOL", "FATAL");
    throw err;
  }
}

/** Ensures the consent table exists. */
async function ensureTable(db) {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS user_consent_channel (
        user_id    VARCHAR(64) NOT NULL,
        channel_id VARCHAR(64) NOT NULL,
        chat       TINYINT(1)  NOT NULL DEFAULT 0,
        voice      TINYINT(1)  NOT NULL DEFAULT 0,
        updated_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, channel_id)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
  } catch (err) {
    await reportError(err, null, "CONSENT_ENSURE_TABLE", "FATAL");
    throw err;
  }
}

/** Fetches consent record for a user × channel. */
async function getConsent(userId, channelId) {
  try {
    const db = await getPool();
    const [rows] = await db.execute(
      `SELECT user_id, channel_id, chat, voice
         FROM user_consent_channel
        WHERE user_id=? AND channel_id=?
        LIMIT 1`,
      [String(userId), String(channelId)]
    );
    return rows[0] || { user_id: String(userId), channel_id: String(channelId), chat: 0, voice: 0 };
  } catch (err) {
    await reportError(err, null, "CONSENT_GET", "ERROR");
    return { user_id: String(userId), channel_id: String(channelId), chat: 0, voice: 0 };
  }
}

/** Checks chat consent. */
async function hasChatConsent(userId, channelId) {
  try {
    const c = await getConsent(userId, channelId);
    return !!c.chat;
  } catch (err) {
    await reportError(err, null, "CONSENT_HAS_CHAT", "ERROR");
    return false;
  }
}

/** Checks voice consent. */
async function hasVoiceConsent(userId, channelId) {
  try {
    const c = await getConsent(userId, channelId);
    return !!c.voice;
  } catch (err) {
    await reportError(err, null, "CONSENT_HAS_VOICE", "ERROR");
    return false;
  }
}

/** Sets or clears chat consent. */
async function setChatConsent(userId, channelId, value) {
  try {
    const db = await getPool();
    const uid = String(userId);
    const cid = String(channelId);

    if (value) {
      await db.execute(
        `INSERT INTO user_consent_channel (user_id, channel_id, chat, voice)
         VALUES (?, ?, 1, 0)
         ON DUPLICATE KEY UPDATE chat=1`,
        [uid, cid]
      );
      return;
    }

    await db.execute(
      `UPDATE user_consent_channel SET chat=0 WHERE user_id=? AND channel_id=?`,
      [uid, cid]
    );

    const c = await getConsent(uid, cid);
    if (!c.chat && !c.voice) {
      await db.execute(
        `DELETE FROM user_consent_channel WHERE user_id=? AND channel_id=?`,
        [uid, cid]
      );
    }
  } catch (err) {
    await reportError(err, null, "CONSENT_SET_CHAT", "ERROR");
    throw err;
  }
}

/** Sets or clears voice consent. */
async function setVoiceConsent(userId, channelId, value) {
  try {
    const db = await getPool();
    const uid = String(userId);
    const cid = String(channelId);

    if (value) {
      await db.execute(
        `INSERT INTO user_consent_channel (user_id, channel_id, chat, voice)
         VALUES (?, ?, 0, 1)
         ON DUPLICATE KEY UPDATE voice=1`,
        [uid, cid]
      );
      return;
    }

    await db.execute(
      `UPDATE user_consent_channel SET voice=0 WHERE user_id=? AND channel_id=?`,
      [uid, cid]
    );

    const c = await getConsent(uid, cid);
    if (!c.chat && !c.voice) {
      await db.execute(
        `DELETE FROM user_consent_channel WHERE user_id=? AND channel_id=?`,
        [uid, cid]
      );
    }
  } catch (err) {
    await reportError(err, null, "CONSENT_SET_VOICE", "ERROR");
    throw err;
  }
}

module.exports = {
  hasChatConsent,
  hasVoiceConsent,
  setChatConsent,
  setVoiceConsent,
  getConsent,
};

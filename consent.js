// consent.js — clean v1.0
// Channel-scoped consent storage per user_id × channel_id in MySQL.

const mysql = require("mysql2/promise");

let pool = null;

/** Returns a shared MySQL pool and ensures the table exists once. */
async function getPool() {
  if (!pool) {
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
  }
  return pool;
}

/** Ensures the consent table exists. */
async function ensureTable(db) {
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
}

/** Fetches consent record for a user × channel. */
async function getConsent(userId, channelId) {
  const db = await getPool();
  const [rows] = await db.execute(
    `SELECT user_id, channel_id, chat, voice
       FROM user_consent_channel
      WHERE user_id=? AND channel_id=?
      LIMIT 1`,
    [String(userId), String(channelId)]
  );
  return rows[0] || { user_id: String(userId), channel_id: String(channelId), chat: 0, voice: 0 };
}

/** Checks chat consent. */
async function hasChatConsent(userId, channelId) {
  const c = await getConsent(userId, channelId);
  return !!c.chat;
}

/** Checks voice consent. */
async function hasVoiceConsent(userId, channelId) {
  const c = await getConsent(userId, channelId);
  return !!c.voice;
}

/** Sets or clears chat consent. */
async function setChatConsent(userId, channelId, value) {
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
}

/** Sets or clears voice consent. */
async function setVoiceConsent(userId, channelId, value) {
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
}

module.exports = {
  hasChatConsent,
  hasVoiceConsent,
  setChatConsent,
  setVoiceConsent,
  getConsent,
};

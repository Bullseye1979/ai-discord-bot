// consent.js — v1.0
// Persistente Einwilligungen für Chat/Voice in MySQL

const mysql = require('mysql2/promise');

let pool = null;
async function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 5,
      charset: 'utf8mb4'
    });
    await ensureTable();
  }
  return pool;
}

async function ensureTable() {
  const db = await getPool();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS user_consent (
      user_id    VARCHAR(64) PRIMARY KEY,
      chat       TINYINT(1) NOT NULL DEFAULT 0,
      voice      TINYINT(1) NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                   ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
}

async function getConsent(userId) {
  const db = await getPool();
  const [rows] = await db.execute(
    `SELECT user_id, chat, voice FROM user_consent WHERE user_id = ? LIMIT 1`,
    [String(userId)]
  );
  return rows[0] || { user_id: String(userId), chat: 0, voice: 0 };
}

async function hasChatConsent(userId) {
  const c = await getConsent(userId);
  return !!c.chat;
}
async function hasVoiceConsent(userId) {
  const c = await getConsent(userId);
  return !!c.voice;
}

async function setChatConsent(userId, value) {
  const db = await getPool();
  const uid = String(userId);
  if (value) {
    await db.execute(
      `INSERT INTO user_consent (user_id, chat, voice)
       VALUES (?, 1, 0)
       ON DUPLICATE KEY UPDATE chat = 1`,
      [uid]
    );
  } else {
    // withdrawl_chat: auf 0 setzen; wenn beide 0 → Datensatz löschen
    await db.execute(`UPDATE user_consent SET chat = 0 WHERE user_id = ?`, [uid]);
    const c = await getConsent(uid);
    if (!c.chat && !c.voice) {
      await db.execute(`DELETE FROM user_consent WHERE user_id = ?`, [uid]);
    }
  }
}

async function setVoiceConsent(userId, value) {
  const db = await getPool();
  const uid = String(userId);
  if (value) {
    await db.execute(
      `INSERT INTO user_consent (user_id, chat, voice)
       VALUES (?, 0, 1)
       ON DUPLICATE KEY UPDATE voice = 1`,
      [uid]
    );
  } else {
    // withdrawl_voice: auf 0 setzen; wenn beide 0 → Datensatz löschen
    await db.execute(`UPDATE user_consent SET voice = 0 WHERE user_id = ?`, [uid]);
    const c = await getConsent(uid);
    if (!c.chat && !c.voice) {
      await db.execute(`DELETE FROM user_consent WHERE user_id = ?`, [uid]);
    }
  }
}

module.exports = {
  hasChatConsent,
  hasVoiceConsent,
  setChatConsent,
  setVoiceConsent,
  getConsent
};

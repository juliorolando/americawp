const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'wasappanel.db'));

db.exec(`PRAGMA journal_mode = WAL`);
db.exec(`PRAGMA foreign_keys = ON`);

db.exec(`
  CREATE TABLE IF NOT EXISTS chats (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_or_name TEXT    NOT NULL UNIQUE,
    first_seen    INTEGER NOT NULL,
    last_seen     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    INTEGER NOT NULL REFERENCES chats(id),
    direction  TEXT    NOT NULL CHECK(direction IN ('in', 'out')),
    body       TEXT    NOT NULL,
    timestamp  INTEGER NOT NULL,
    wa_id      TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_chat_id   ON messages(chat_id);
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_wa_id ON messages(wa_id) WHERE wa_id IS NOT NULL;
`);

// Migración: agregar wa_id a bases de datos existentes sin la columna
try {
  const cols = db.prepare('PRAGMA table_info(messages)').all();
  if (!cols.find(c => c.name === 'wa_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN wa_id TEXT');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_wa_id ON messages(wa_id) WHERE wa_id IS NOT NULL');
  }
} catch (_) {}

const stmts = {
  findChat:    db.prepare('SELECT id FROM chats WHERE phone_or_name = ?'),
  updateChat:  db.prepare('UPDATE chats SET last_seen = ? WHERE id = ?'),
  insertChat:  db.prepare('INSERT INTO chats (phone_or_name, first_seen, last_seen) VALUES (?, ?, ?)'),
  findByWaId:  db.prepare('SELECT id FROM messages WHERE wa_id = ?'),
  recentMsgs:  db.prepare('SELECT body, timestamp FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT 20'),
  insertMsg:   db.prepare('INSERT INTO messages (chat_id, direction, body, timestamp, wa_id) VALUES (?, ?, ?, ?, ?)'),
  listChats:   db.prepare(`
    SELECT
      c.id,
      c.phone_or_name,
      c.last_seen,
      COUNT(m.id) AS message_count,
      (SELECT body FROM messages WHERE chat_id = c.id ORDER BY timestamp DESC LIMIT 1) AS last_message
    FROM chats c
    LEFT JOIN messages m ON m.chat_id = c.id
    GROUP BY c.id
    ORDER BY c.last_seen DESC
  `),
  getChat:     db.prepare('SELECT * FROM chats WHERE id = ?'),
  getMsgs:     db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC'),
};

function upsertChat(phoneOrName) {
  const now      = Date.now();
  const existing = stmts.findChat.get(phoneOrName);
  if (existing) {
    stmts.updateChat.run(now, existing.id);
    return existing.id;
  }
  const info = stmts.insertChat.run(phoneOrName, now, now);
  return info.lastInsertRowid;
}

function saveMessage({ chatId, direction, body, timestamp, waId }) {
  // Dedup primario: wa_id único (evita re-insertar el mismo mensaje de WA)
  if (waId) {
    const exists = stmts.findByWaId.get(waId);
    if (exists) return null;
  }

  // Dedup secundario: body + timestamp aproximado (para mensajes sin wa_id)
  if (!waId) {
    const recent = stmts.recentMsgs.all(chatId);
    const isDuplicate = recent.some(
      (m) => m.body === body && Math.abs(m.timestamp - timestamp) < 5000
    );
    if (isDuplicate) return null;
  }

  const info = stmts.insertMsg.run(chatId, direction, body, timestamp, waId || null);
  return info.lastInsertRowid;
}

function getChats()          { return stmts.listChats.all(); }
function getMessages(chatId) { return stmts.getMsgs.all(chatId); }
function getChat(chatId)     { return stmts.getChat.get(chatId); }

module.exports = { db, upsertChat, saveMessage, getChats, getMessages, getChat };

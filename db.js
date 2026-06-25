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

// Migración: columna hidden en chats
try {
  const chatCols = db.prepare('PRAGMA table_info(chats)').all();
  if (!chatCols.find(c => c.name === 'hidden')) {
    db.exec('ALTER TABLE chats ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
  }
  if (!chatCols.find(c => c.name === 'status')) {
    db.exec("ALTER TABLE chats ADD COLUMN status TEXT NOT NULL DEFAULT 'pendiente'");
  }
  if (!chatCols.find(c => c.name === 'notes')) {
    db.exec("ALTER TABLE chats ADD COLUMN notes TEXT NOT NULL DEFAULT ''");
  }
  if (!chatCols.find(c => c.name === 'ai_summary')) {
    db.exec("ALTER TABLE chats ADD COLUMN ai_summary TEXT NOT NULL DEFAULT ''");
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
      c.status,
      c.ai_summary,
      COUNT(m.id) AS message_count,
      (SELECT body      FROM messages WHERE chat_id = c.id ORDER BY timestamp DESC LIMIT 1) AS last_message,
      (SELECT direction FROM messages WHERE chat_id = c.id ORDER BY timestamp DESC LIMIT 1) AS last_direction,
      (SELECT timestamp FROM messages WHERE chat_id = c.id ORDER BY timestamp DESC LIMIT 1) AS last_message_ts,
      (SELECT GROUP_CONCAT(body, ' ') FROM (SELECT body FROM messages WHERE chat_id = c.id ORDER BY timestamp DESC LIMIT 30)) AS sample_text
    FROM chats c
    LEFT JOIN messages m ON m.chat_id = c.id
    WHERE c.hidden = 0
    GROUP BY c.id
    ORDER BY last_message_ts DESC
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

function saveMessagesBatch(msgs) {
  let saved = 0;
  db.exec('BEGIN');
  try {
    for (const { chatName, direction, body, timestamp, waId } of msgs) {
      if (!chatName || !direction || !body) continue;
      const chatId = upsertChat(chatName);
      const id     = saveMessage({ chatId, direction, body, timestamp: timestamp || Date.now(), waId });
      if (id !== null) saved++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return saved;
}

function getChats()          { return stmts.listChats.all(); }
function getMessages(chatId) { return stmts.getMsgs.all(chatId); }
function getChat(chatId)     { return stmts.getChat.get(chatId); }

function getPendingChats() {
  return db.prepare(`
    SELECT
      c.id,
      c.phone_or_name,
      c.last_seen,
      COUNT(m.id) AS message_count,
      (SELECT body      FROM messages WHERE chat_id = c.id ORDER BY timestamp DESC LIMIT 1) AS last_message,
      (SELECT timestamp FROM messages WHERE chat_id = c.id AND direction = 'in' ORDER BY timestamp DESC LIMIT 1) AS waiting_since
    FROM chats c
    JOIN messages m ON m.chat_id = c.id
    WHERE (SELECT direction FROM messages WHERE chat_id = c.id ORDER BY timestamp DESC LIMIT 1) = 'in'
      AND c.status != 'resuelto'
      AND c.hidden = 0
    GROUP BY c.id
    ORDER BY c.last_seen ASC
  `).all();
}

function searchMessages(q) {
  return db.prepare(`
    SELECT m.id, m.body, m.direction, m.timestamp, m.chat_id, c.phone_or_name
    FROM messages m
    JOIN chats c ON c.id = m.chat_id
    WHERE m.body LIKE ?
    ORDER BY m.timestamp DESC
    LIMIT 150
  `).all(`%${q}%`);
}

function getActivityStats({ from = null, to = null } = {}) {
  const hasRange = from !== null && to !== null;

  const byHourRaw = hasRange
    ? db.prepare(`SELECT CAST(strftime('%H', datetime(timestamp/1000, 'unixepoch', 'localtime')) AS INTEGER) AS hour, COUNT(*) AS count FROM messages WHERE timestamp >= ? AND timestamp <= ? GROUP BY hour ORDER BY hour`).all(from, to)
    : db.prepare(`SELECT CAST(strftime('%H', datetime(timestamp/1000, 'unixepoch', 'localtime')) AS INTEGER) AS hour, COUNT(*) AS count FROM messages GROUP BY hour ORDER BY hour`).all();

  const byHour = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    count: (byHourRaw.find(r => r.hour === h) || { count: 0 }).count,
  }));

  const since30 = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const byDay = hasRange
    ? db.prepare(`SELECT date(datetime(timestamp/1000, 'unixepoch', 'localtime')) AS day, COUNT(*) AS count FROM messages WHERE timestamp >= ? AND timestamp <= ? GROUP BY day ORDER BY day`).all(from, to)
    : db.prepare(`SELECT date(datetime(timestamp/1000, 'unixepoch', 'localtime')) AS day, COUNT(*) AS count FROM messages WHERE timestamp >= ? GROUP BY day ORDER BY day`).all(since30);

  const total = hasRange
    ? db.prepare('SELECT COUNT(*) AS n FROM messages WHERE timestamp >= ? AND timestamp <= ?').get(from, to).n
    : db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;

  const totalChats = hasRange
    ? db.prepare('SELECT COUNT(DISTINCT chat_id) AS n FROM messages WHERE timestamp >= ? AND timestamp <= ?').get(from, to).n
    : db.prepare('SELECT COUNT(*) AS n FROM chats WHERE hidden = 0').get().n;

  return { byHour, byDay, total, totalChats };
}

function getStats() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const ts = todayStart.getTime();

  const msgsToday      = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE timestamp >= ?').get(ts).n;
  const chatsToday     = db.prepare('SELECT COUNT(*) AS n FROM chats WHERE last_seen >= ?').get(ts).n;
  const sinRespuesta   = db.prepare(`
    SELECT COUNT(*) AS n FROM chats
    WHERE last_seen >= ?
      AND status != 'resuelto'
      AND hidden = 0
      AND (SELECT direction FROM messages WHERE chat_id = chats.id ORDER BY timestamp DESC LIMIT 1) = 'in'
  `).get(ts).n;

  return { msgsToday, chatsToday, sinRespuesta };
}

function getContacts() {
  return db.prepare(`
    SELECT
      c.id,
      c.phone_or_name,
      c.first_seen,
      c.status,
      COUNT(m.id) AS message_count,
      (SELECT timestamp FROM messages WHERE chat_id = c.id ORDER BY timestamp DESC LIMIT 1) AS last_message_ts
    FROM chats c
    LEFT JOIN messages m ON m.chat_id = c.id
    WHERE c.hidden = 0
    GROUP BY c.id
    ORDER BY c.phone_or_name COLLATE NOCASE ASC
  `).all();
}

function hideChat(id)     { db.prepare('UPDATE chats SET hidden = 1 WHERE id = ?').run(id); }
function unhideChat(id)   { db.prepare('UPDATE chats SET hidden = 0 WHERE id = ?').run(id); }
function setStatus(id, status) { db.prepare('UPDATE chats SET status = ? WHERE id = ?').run(status, id); }
function setNotes(id, notes)     { db.prepare('UPDATE chats SET notes = ? WHERE id = ?').run(notes, id); }
function setSummary(id, summary) { db.prepare('UPDATE chats SET ai_summary = ? WHERE id = ?').run(summary, id); }

function getHiddenChats() {
  return db.prepare(`
    SELECT
      c.id,
      c.phone_or_name,
      COUNT(m.id) AS message_count,
      (SELECT body      FROM messages WHERE chat_id = c.id ORDER BY timestamp DESC LIMIT 1) AS last_message,
      (SELECT timestamp FROM messages WHERE chat_id = c.id ORDER BY timestamp DESC LIMIT 1) AS last_message_ts
    FROM chats c
    LEFT JOIN messages m ON m.chat_id = c.id
    WHERE c.hidden = 1
    GROUP BY c.id
    ORDER BY last_message_ts DESC
  `).all();
}

module.exports = { db, upsertChat, saveMessage, saveMessagesBatch, getChats, getMessages, getChat, getStats, getPendingChats, searchMessages, getActivityStats, getContacts, hideChat, unhideChat, getHiddenChats, setStatus, setNotes, setSummary };

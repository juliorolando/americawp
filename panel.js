require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const session = require('express-session');
const path    = require('path');
const { getChats, getChat, getMessages, upsertChat, saveMessage, saveMessagesBatch,
        getStats, getPendingChats, searchMessages, getActivityStats,
        hideChat, unhideChat, getHiddenChats } = require('./db');

function categorize(text) {
  const t = (text || '').toLowerCase();
  if (/cancel|no voy|no puedo|no pod/.test(t))
    return { label: 'Cancelación', color: '#ef5350', bg: '#ffebee' };
  if (/queja|reclamo|problem|terrible|pésimo|pesimo|molest|mal servicio/.test(t))
    return { label: 'Queja', color: '#f57c00', bg: '#fff3e0' };
  if (/reserva|reservar|habitac|disponib|check.?in|check.?out|noche|noches/.test(t))
    return { label: 'Reserva', color: '#1976d2', bg: '#e3f2fd' };
  if (/precio|costo|cuánto|cuanto|tarifa|valor|cobr|cotiz/.test(t))
    return { label: 'Precio', color: '#7b1fa2', bg: '#f3e5f5' };
  if (/gracias|perfecto|excelente|genial|encantad|increíble|muy bien/.test(t))
    return { label: 'Agradecimiento', color: '#00796b', bg: '#e0f2f1' };
  return { label: 'Consulta', color: '#546e7a', bg: '#eceff1' };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function highlight(text, query) {
  const safe  = escapeHtml(text);
  const regex = new RegExp(escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return safe.replace(regex, m => `<mark>${m}</mark>`);
}

const app  = express();
const PORT = process.env.PORT || 3500;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(session({
  secret:            process.env.SESSION_SECRET || 'dev-secret',
  resave:            false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }, // sesión de 8 horas
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Permite requests desde la extensión de Chrome
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (origin.startsWith('chrome-extension://') || !origin) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
}

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ ok: false, error: 'No autorizado' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
app.get('/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/');
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { user, pass } = req.body;
  if (user === process.env.PANEL_USER && pass === process.env.PANEL_PASS) {
    req.session.authenticated = true;
    return res.redirect('/');
  }
  res.render('login', { error: 'Usuario o contraseña incorrectos.' });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------------------------------------------------------------------------
// API — recibe mensajes desde la extensión (requiere API key)
// ---------------------------------------------------------------------------
app.post('/api/messages/batch', requireApiKey, (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ ok: false, error: 'Array de mensajes vacío o inválido' });
    }
    const saved = saveMessagesBatch(messages);
    if (saved > 0) console.log(`[API] Historial: ${saved} mensajes nuevos de ${messages.length} recibidos`);
    res.json({ ok: true, saved });
  } catch (err) {
    console.error('[API] Error en batch:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/message', requireApiKey, (req, res) => {
  try {
    const { chatName, direction, body, timestamp, waId } = req.body;
    if (!chatName || !direction || !body) {
      return res.status(400).json({ ok: false, error: 'Faltan campos requeridos' });
    }
    const chatId = upsertChat(chatName);
    const msgId  = saveMessage({ chatId, direction, body, timestamp: timestamp || Date.now(), waId });
    res.json({ ok: true, msgId });
  } catch (err) {
    console.error('[API] Error guardando mensaje:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Ocultar / mostrar chats
// ---------------------------------------------------------------------------
app.post('/chat/:id/hide', requireAuth, (req, res) => {
  hideChat(req.params.id);
  res.json({ ok: true });
});

app.post('/chat/:id/show', requireAuth, (req, res) => {
  unhideChat(req.params.id);
  res.redirect('/ocultos');
});

app.get('/ocultos', requireAuth, (req, res) => {
  const chats = getHiddenChats();
  res.render('ocultos', { chats });
});

// ---------------------------------------------------------------------------
// Panel (protegido)
// ---------------------------------------------------------------------------
app.get('/', requireAuth, (req, res) => {
  const raw   = getChats();
  const chats = raw.map(c => ({ ...c, category: categorize(c.sample_text) }));
  const stats = getStats();
  res.render('index', { chats, stats });
});

app.get('/pendientes', requireAuth, (req, res) => {
  const chats = getPendingChats();
  res.render('pendientes', { chats });
});

app.get('/estadisticas', requireAuth, (req, res) => {
  const data = getActivityStats();
  res.render('estadisticas', { data });
});

app.get('/buscar', requireAuth, (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.render('buscar', { q: '', results: [], grouped: [] });

  const results = searchMessages(q);

  // Agrupar por chat
  const map = new Map();
  results.forEach(r => {
    if (!map.has(r.chat_id)) map.set(r.chat_id, { chat_id: r.chat_id, name: r.phone_or_name, msgs: [] });
    map.get(r.chat_id).msgs.push(r);
  });

  res.render('buscar', { q, results, grouped: [...map.values()], highlight });
});

app.get('/chat/:id', requireAuth, (req, res) => {
  const chat = getChat(req.params.id);
  if (!chat) return res.status(404).send('Chat no encontrado');
  const messages = getMessages(req.params.id);
  res.render('chat', { chat, messages });
});

app.get('/export/:id', requireAuth, (req, res) => {
  const chat = getChat(req.params.id);
  if (!chat) return res.status(404).send('Chat no encontrado');
  const messages = getMessages(req.params.id);

  const lines = messages.map((m) => {
    const d    = new Date(m.timestamp);
    const hms  = d.toLocaleTimeString('es-AR', { hour12: false });
    const date = d.toLocaleDateString('es-AR');
    const dir  = m.direction === 'in' ? chat.phone_or_name : 'Recepción';
    return `[${date} ${hms}] ${dir}: ${m.body}`;
  });

  const filename = `${chat.phone_or_name.replace(/[^\w\s-]/g, '')}.txt`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(lines.join('\n'));
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`WasapPanel corriendo en http://localhost:${PORT}`);
});

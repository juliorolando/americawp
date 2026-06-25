require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const session = require('express-session');
const path    = require('path');
const { getChats, getChat, getMessages, upsertChat, saveMessage, saveMessagesBatch,
        getStats, getPendingChats, searchMessages, getActivityStats,
        hideChat, unhideChat, getHiddenChats,
        setStatus, setNotes, setSummary, getContacts } = require('./db');

// Devuelve solo los mensajes de la sesión actual (último bloque sin gap > 12 h)
function currentSession(messages) {
  if (!messages.length) return [];
  const GAP = 12 * 3_600_000;
  let start = 0;
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].timestamp - messages[i - 1].timestamp > GAP) start = i;
  }
  return messages.slice(start, start + 80);
}

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

app.post('/chat/:id/status', requireAuth, (req, res) => {
  const { status } = req.body;
  if (!['pendiente', 'en_proceso', 'resuelto'].includes(status)) {
    return res.status(400).json({ ok: false });
  }
  setStatus(req.params.id, status);
  res.json({ ok: true });
});

app.post('/chat/:id/notes', requireAuth, (req, res) => {
  setNotes(req.params.id, req.body.notes || '');
  res.json({ ok: true });
});

app.post('/chat/:id/summarize', requireAuth, async (req, res) => {
  const chat = getChat(req.params.id);
  if (!chat) return res.status(404).json({ ok: false, error: 'Chat no encontrado' });

  const messages = getMessages(req.params.id);
  if (!messages.length) return res.json({ ok: false, error: 'Sin mensajes' });

  const session = currentSession(messages);
  if (!session.length) return res.json({ ok: false, error: 'Sin mensajes en la sesión actual' });

  const convo = session.map(m =>
    `[${m.direction === 'in' ? 'CLIENTE' : 'RECEPCIÓN'}] ${m.body}`
  ).join('\n');

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content: 'Sos un asistente que analiza conversaciones de WhatsApp de un hotel. En la conversación, los mensajes etiquetados [CLIENTE] son del huésped o cliente externo que contacta al hotel. Los mensajes etiquetados [RECEPCIÓN] son del personal del hotel respondiendo. Respondé siempre en español. Resumí en 2 o 3 oraciones cortas y directas: qué quiere o consultó el cliente, qué le respondió la recepción, y si quedó algo pendiente. Sin viñetas ni títulos, solo texto corrido.',
          },
          {
            role: 'user',
            content: `Conversación con el contacto "${chat.phone_or_name}":\n\n${convo}`,
          },
        ],
        max_tokens: 180,
        temperature: 0.2,
      }),
    });
    const data = await r.json();
    const summary = data.choices?.[0]?.message?.content?.trim();
    if (!summary) return res.json({ ok: false, error: 'Sin respuesta del modelo' });
    setSummary(req.params.id, summary);
    res.json({ ok: true, summary });
  } catch (err) {
    console.error('[AI] Error Groq:', err.message);
    res.status(500).json({ ok: false, error: 'Error al conectar con Groq' });
  }
});

app.post('/chat/:id/show', requireAuth, (req, res) => {
  unhideChat(req.params.id);
  res.redirect('/ocultos');
});

app.get('/contactos', requireAuth, (req, res) => {
  const contacts = getContacts();
  res.render('contactos', { contacts });
});

app.get('/ocultos', requireAuth, (req, res) => {
  const chats = getHiddenChats();
  res.render('ocultos', { chats });
});

// ---------------------------------------------------------------------------
// Panel (protegido)
// ---------------------------------------------------------------------------
app.get('/', requireAuth, (req, res) => {
  const chats = getChats();
  const stats = getStats();
  res.render('index', { chats, stats });
});

app.get('/pendientes', requireAuth, (req, res) => {
  const chats = getPendingChats();
  res.render('pendientes', { chats });
});

app.get('/estadisticas', requireAuth, (req, res) => {
  const { from, to, preset } = req.query;
  let fromTs = null, toTs = null;

  if (preset) {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    if      (preset === 'semana')    { fromTs = now - 7  * day; toTs = now; }
    else if (preset === 'mes')       { fromTs = now - 30 * day; toTs = now; }
    else if (preset === 'trimestre') { fromTs = now - 90 * day; toTs = now; }
  } else if (from && to) {
    fromTs = new Date(from + 'T00:00:00').getTime();
    toTs   = new Date(to   + 'T23:59:59').getTime();
  }

  const data = getActivityStats({ from: fromTs, to: toTs });
  res.render('estadisticas', { data, from: from || '', to: to || '', preset: preset || '' });
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

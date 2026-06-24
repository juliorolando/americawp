const express = require('express');
const path    = require('path');
const { getChats, getChat, getMessages } = require('./db');

const app  = express();
const PORT = 3500;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

// Lista de chats
app.get('/', (req, res) => {
  const chats = getChats();
  res.render('index', { chats });
});

// Conversación de un chat
app.get('/chat/:id', (req, res) => {
  const chat = getChat(req.params.id);
  if (!chat) return res.status(404).send('Chat no encontrado');
  const messages = getMessages(req.params.id);
  res.render('chat', { chat, messages });
});

// Exportar conversación como .txt
app.get('/export/:id', (req, res) => {
  const chat = getChat(req.params.id);
  if (!chat) return res.status(404).send('Chat no encontrado');
  const messages = getMessages(req.params.id);

  const lines = messages.map((m) => {
    const d   = new Date(m.timestamp);
    const hms = d.toLocaleTimeString('es-AR', { hour12: false });
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

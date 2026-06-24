const puppeteer = require('puppeteer');
const path = require('path');
const { upsertChat, saveMessage } = require('./db');

// ---------------------------------------------------------------------------
// Selectores — actualizar aquí si WhatsApp cambia su DOM
// ---------------------------------------------------------------------------
const SELECTORS = {
  chatHeader: '[data-testid="conversation-info-header"]',
  chatTitle:  '[data-testid="conversation-info-header-chat-title"]',

  msgContainerCandidates: [
    '[data-testid="conversation-panel-messages"]',
    '#main [role="application"]',
    '#main [role="region"]',
    '#main',
  ],

  msgNode:       'div[data-id]',
  msgText:       'span.selectable-text',
  msgOutClasses: ['message-out', 'msg-out'],
  deliveryCheck: '[data-testid="msg-dbl-check"], [data-testid="msg-check"], [data-testid="msg-time-read"]',
};

const SESSION_DIR  = path.join(__dirname, 'whatsapp-session');
const WA_URL       = 'https://web.whatsapp.com';
const RECONNECT_MS = 5000;

// ---------------------------------------------------------------------------
// Helpers de log
// ---------------------------------------------------------------------------
function ts() { return new Date().toTimeString().slice(0, 8); }
function log(direction, chat, body) {
  const dir = direction === 'in' ? '[IN] ' : '[OUT]';
  console.log(`[${ts()}] ${dir} Chat: ${chat} | Msg: ${body.slice(0, 80)}`);
}
function warn(msg) { console.warn(`[${ts()}] [WARN] ${msg}`); }

// ---------------------------------------------------------------------------
// Script inyectado en el browser
// ---------------------------------------------------------------------------
function buildObserverScript(selectors) {
  return `(function() {
  if (window.__wasapObserver) {
    window.__wasapObserver.disconnect();
    window.__wasapObserver = null;
  }

  const candidates = ${JSON.stringify(selectors.msgContainerCandidates)};
  let container = null, usedSelector = null;
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el) { container = el; usedSelector = sel; break; }
  }
  if (!container) return { ok: false, reason: 'no-container' };

  const outClasses = ${JSON.stringify(selectors.msgOutClasses)};
  const checkSel   = ${JSON.stringify(selectors.deliveryCheck)};
  const msgNodeSel = ${JSON.stringify(selectors.msgNode)};
  const msgTextSel = ${JSON.stringify(selectors.msgText)};
  const titleSel   = ${JSON.stringify(selectors.chatTitle)};

  // seen: data-ids ya procesados + los que estaban al abrir el chat (historia)
  const seen = new Set(
    [...container.querySelectorAll(msgNodeSel)]
      .map(n => n.getAttribute('data-id'))
      .filter(Boolean)
  );

  // pending: nodos que llegaron sin texto todavía — se reintentan cuando
  // el observer detecta que se agregó contenido como hijo de ese nodo
  const pending = new Map();

  let dirDebugDone = false;
  function debugDirection(node) {
    if (dirDebugDone) return;
    dirDebugDone = true;
    console.log('[wasap] === DIRECTION DEBUG (primer mensaje sin clase conocida) ===');
    let el = node, depth = 0;
    while (el && el !== document.body && depth < 10) {
      console.log('[wasap] d=' + depth
        + ' tag=' + el.tagName
        + ' class="' + (el.className || '') + '"'
        + ' testid=' + (el.getAttribute('data-testid') || '')
        + ' data-id=' + (el.getAttribute('data-id') || ''));
      el = el.parentElement; depth++;
    }
    console.log('[wasap] ==============================');
  }

  function isOutgoing(node) {
    // Estrategia principal: posición visual del texto dentro del bubble.
    // Los mensajes enviados están alineados a la derecha; los recibidos a la izquierda.
    // Usamos el span de texto (que vive dentro del bubble) en lugar del div[data-id]
    // porque el div suele ser full-width en layouts de lista virtual.
    const textEl        = node.querySelector(msgTextSel);
    const probe         = textEl || node;
    const probeRect     = probe.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    if (probeRect.width > 0 && containerRect.width > 0) {
      const probeCenter     = probeRect.left + probeRect.width / 2;
      const containerCenter = containerRect.left + containerRect.width / 2;
      return probeCenter > containerCenter;
    }

    // Fallback A: check marks de entrega (solo en mensajes enviados)
    if (node.querySelector(checkSel)) return true;

    // Fallback B: prefijo del data-id (formato legacy de WA)
    const dataId = node.getAttribute('data-id') || '';
    if (dataId.startsWith('true_'))  return true;
    if (dataId.startsWith('false_')) return false;

    // Fallback C: clases CSS conocidas en ancestros
    let el = node;
    while (el && el !== container) {
      if (el.classList) {
        for (const cls of outClasses) {
          if (el.classList.contains(cls)) return true;
        }
      }
      el = el.parentElement;
    }

    debugDirection(node);
    return false;
  }

  // Intenta extraer y guardar un mensaje. Devuelve true si lo procesó.
  function processNode(node, dataId) {
    const textEl = node.querySelector(msgTextSel);
    const body   = textEl ? textEl.innerText.trim() : '';
    if (!body) return false;

    seen.add(dataId);
    pending.delete(dataId);

    const direction = isOutgoing(node) ? 'out' : 'in';
    const titleEl   = document.querySelector(titleSel);
    const chatName  = titleEl ? titleEl.innerText.trim() : 'Desconocido';

    window.saveMessage({ chatName, direction, body, timestamp: Date.now(), waId: dataId });
    return true;
  }

  function extractMessage(node) {
    const dataId = node.getAttribute('data-id');
    if (!dataId || seen.has(dataId) || pending.has(dataId)) return;

    if (!processNode(node, dataId)) {
      // Texto todavía no disponible — guardar referencia y esperar
      pending.set(dataId, node);
    }
  }

  // Cuando llega contenido como hijo de un nodo pendiente, reintentarlo
  function retryPendingFor(mutTarget) {
    if (pending.size === 0) return;
    let el = mutTarget;
    while (el && el !== container) {
      const did = el.getAttribute ? el.getAttribute('data-id') : null;
      if (did && pending.has(did)) {
        processNode(pending.get(did), did);
        break;
      }
      el = el.parentElement;
    }
  }

  window.__wasapObserver = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches && node.matches(msgNodeSel)) extractMessage(node);
        if (node.querySelectorAll) {
          for (const n of node.querySelectorAll(msgNodeSel)) extractMessage(n);
        }
      }
      retryPendingFor(mut.target);
    }
  });

  window.__wasapObserver.observe(container, { childList: true, subtree: true });
  console.log('[wasap] Observer activo en: ' + usedSelector + ' | Historia ignorada: ' + seen.size + ' msgs');
  return { ok: true, selector: usedSelector };
})()`;
}

// ---------------------------------------------------------------------------
// Lógica principal
// ---------------------------------------------------------------------------
async function launch() {
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: SESSION_DIR,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: null,
  });

  const [page] = await browser.pages();
  await page.setDefaultNavigationTimeout(120_000);

  await page.exposeFunction('saveMessage', async ({ chatName, direction, body, timestamp, waId }) => {
    try {
      const chatId = upsertChat(chatName);
      const msgId  = saveMessage({ chatId, direction, body, timestamp, waId });
      if (msgId !== null) log(direction, chatName, body);
    } catch (err) {
      warn(`Error guardando mensaje: ${err.message}`);
    }
  });

  console.log(`[${ts()}] Abriendo WhatsApp Web…`);
  await page.goto(WA_URL, { waitUntil: 'networkidle2' });

  console.log(`[${ts()}] Esperando sesión de WhatsApp…`);
  await page.waitForSelector('#pane-side, canvas[aria-label="Scan me!"]', { timeout: 120_000 })
    .catch(() => warn('No se detectó panel lateral ni QR. Continuando de todos modos.'));

  console.log(`[${ts()}] WhatsApp listo. Inyectando observer…`);
  await injectObserver(page);

  page.on('framenavigated', async (frame) => {
    if (frame !== page.mainFrame()) return;
    console.log(`[${ts()}] Navegación detectada — re-inyectando observer…`);
    await delay(1500);
    await injectObserver(page);
  });

  setInterval(async () => {
    try {
      const { chatOpen, observerActive } = await page.evaluate((headerSel) => ({
        chatOpen:       !!document.querySelector(headerSel),
        observerActive: !!window.__wasapObserver,
      }), SELECTORS.chatHeader);

      if (chatOpen && !observerActive) {
        warn('Chat abierto pero observer caído — re-inyectando…');
        await injectObserver(page);
      }
    } catch (_) {}
  }, 5_000);

  browser.on('disconnected', () => {
    warn('Browser desconectado. Reiniciando en 5 s…');
    setTimeout(launch, RECONNECT_MS);
  });
}

async function injectObserver(page) {
  try {
    const result = await page.evaluate(buildObserverScript(SELECTORS));
    if (!result || !result.ok) {
      const chatOpen = await page.evaluate(
        (sel) => !!document.querySelector(sel), SELECTORS.chatHeader
      );
      if (chatOpen) {
        warn('Container no encontrado con ningún selector. Revisar SELECTORS en monitor.js');
        warn('Abrí DevTools en Chromium (F12) e inspeccioná el contenedor de mensajes');
      }
    } else {
      console.log(`[${ts()}] Observer activo → ${result.selector}`);
    }
  } catch (err) {
    warn(`injectObserver error: ${err.message}`);
  }
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

launch().catch((err) => {
  console.error(`[${ts()}] Error fatal:`, err);
  process.exit(1);
});

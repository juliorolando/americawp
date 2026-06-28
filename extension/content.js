console.log('[WasapPanel] Content script iniciado');

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
  mediaTypes: [
    { sel: '[data-testid="image-thumb"]',    label: '🖼️ Imagen'    },
    { sel: '[data-testid="video-thumb"]',    label: '🎥 Video'     },
    { sel: '[data-testid="audio-player"]',   label: '🎤 Audio'     },
    { sel: '[data-testid="document-thumb"]', label: '📄 Documento' },
    { sel: '[data-testid="sticker-kf"]',     label: '🎨 Sticker'   },
    { sel: '[data-testid="map"]',            label: '📍 Ubicación'  },
    { sel: '[data-testid="vcard"]',          label: '👤 Contacto'  },
    { sel: '[data-testid="poll-creation"]',  label: '📊 Encuesta'  },
  ],
};

let observer         = null;
let currentContainer = null;

function isOutgoing(node) {
  // 1. Más confiable: prefijo del data-id (true_ = enviado, false_ = recibido)
  const dataId = node.getAttribute('data-id') || '';
  if (dataId.startsWith('true_'))  return true;
  if (dataId.startsWith('false_')) return false;

  // 2. Clases CSS específicas de mensajes salientes
  let el = node;
  while (el && el !== currentContainer) {
    if (el.classList) {
      for (const cls of SELECTORS.msgOutClasses) {
        if (el.classList.contains(cls)) return true;
      }
    }
    el = el.parentElement;
  }

  // 3. Checkmarks de entrega (solo en mensajes salientes; excluye msg-time-read que aparece en ambos)
  if (node.querySelector('[data-testid="msg-dbl-check"], [data-testid="msg-check"]')) return true;

  // 4. Posición geométrica como último recurso
  const textEl        = node.querySelector(SELECTORS.msgText);
  const probe         = textEl || node;
  const probeRect     = probe.getBoundingClientRect();
  const containerRect = currentContainer.getBoundingClientRect();
  if (probeRect.width > 0 && containerRect.width > 0) {
    return (probeRect.left + probeRect.width / 2) > (containerRect.left + containerRect.width / 2);
  }

  return false;
}

function getMessageBody(node) {
  // Excluir el bloque citado (reply) para no capturar el texto original como nuevo mensaje
  const quotedBlock = node.querySelector('[data-testid="quoted-message"]') ||
                      node.querySelector('[data-testid="quoted-msg-container"]');

  const allTextEls = [...node.querySelectorAll(SELECTORS.msgText)];
  const textEl     = allTextEls.find(el => !quotedBlock || !quotedBlock.contains(el));
  let body         = textEl ? textEl.innerText.trim() : '';

  if (!body) {
    for (const { sel, label } of SELECTORS.mediaTypes) {
      if (node.querySelector(sel)) { body = label; break; }
    }
  }
  return body;
}

// Lee el timestamp real del atributo data-pre-plain-text.
// Formato WhatsApp: "[HH:MM, D/M/YYYY] Nombre: "
function parseTimestamp(node) {
  try {
    const el = node.querySelector('[data-pre-plain-text]');
    if (!el) return null;
    const attr = el.getAttribute('data-pre-plain-text') || '';
    const m = attr.match(/\[(\d{1,2}):(\d{2})(?::\d{2})?,\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\]/);
    if (!m) return null;
    let [, hh, mm, d, mo, y] = m.map(Number);
    if (y < 100) y += 2000;
    const ts = new Date(y, mo - 1, d, hh, mm).getTime();
    return isNaN(ts) ? null : ts;
  } catch (_) {
    return null;
  }
}

function sendToBackground(data) {
  try { chrome.runtime.sendMessage({ type: 'WASAP_MESSAGE', data }); }
  catch (err) { console.error('[WasapPanel] sendMessage error:', err.message); }
}

function sendBatch(messages) {
  if (!messages.length) return;
  try { chrome.runtime.sendMessage({ type: 'WASAP_BATCH', data: messages }); }
  catch (err) { console.error('[WasapPanel] sendBatch error:', err.message); }
}

function attachObserver() {
  if (observer) {
    observer.disconnect();
    observer = null;
    currentContainer = null;
  }

  let container = null;
  let usedSelector = null;
  for (const sel of SELECTORS.msgContainerCandidates) {
    const el = document.querySelector(sel);
    if (el) { container = el; usedSelector = sel; break; }
  }

  if (!container) {
    console.warn('[WasapPanel] Container no encontrado. Revisar selectores.');
    return;
  }

  currentContainer = container;

  // seen empieza vacío — el historial se agrega abajo luego del observe()
  const seen    = new Set();
  const pending = new Map();

  function getChatName() {
    const el = document.querySelector(SELECTORS.chatTitle);
    return el ? el.innerText.trim() : 'Desconocido';
  }

  function processNode(node, dataId) {
    const body = getMessageBody(node);
    if (!body) return false;

    seen.add(dataId);
    pending.delete(dataId);

    const direction = isOutgoing(node) ? 'out' : 'in';
    const chatName  = getChatName();

    console.log(`[WasapPanel] [${direction.toUpperCase()}] ${chatName}: ${body.slice(0, 60)}`);
    sendToBackground({ chatName, direction, body, timestamp: parseTimestamp(node) || Date.now(), waId: dataId });
    return true;
  }

  function extractMessage(node) {
    const dataId = node.getAttribute('data-id');
    if (!dataId || seen.has(dataId) || pending.has(dataId)) return;
    if (!processNode(node, dataId)) pending.set(dataId, node);
  }

  function retryPendingFor(mutTarget) {
    if (pending.size === 0) return;
    let el = mutTarget;
    while (el && el !== container) {
      const did = el.getAttribute ? el.getAttribute('data-id') : null;
      if (did && pending.has(did)) { processNode(pending.get(did), did); break; }
      el = el.parentElement;
    }
  }

  // ── Observer para mensajes nuevos (idéntico a la versión que funcionaba) ──
  observer = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches && node.matches(SELECTORS.msgNode)) extractMessage(node);
        if (node.querySelectorAll) {
          for (const n of node.querySelectorAll(SELECTORS.msgNode)) extractMessage(n);
        }
      }
      retryPendingFor(mut.target);
    }
  });

  observer.observe(container, { childList: true, subtree: true });
  console.log(`[WasapPanel] Observer activo en: "${usedSelector}"`);

  // ── Capturar historial DESPUÉS del observe() — aislado en try-catch ───────
  // Si algo aquí falla, el observer ya está corriendo y los mensajes nuevos
  // se siguen capturando sin problema.
  try {
    const chatName  = getChatName();
    const histNodes = [...container.querySelectorAll(SELECTORS.msgNode)];
    const batch     = [];

    for (const node of histNodes) {
      const dataId = node.getAttribute('data-id');
      if (!dataId || seen.has(dataId)) continue;

      const body = getMessageBody(node);
      if (!body) continue;

      seen.add(dataId); // evita que el observer lo reenvíe si WhatsApp re-renderiza
      batch.push({
        chatName,
        direction: isOutgoing(node) ? 'out' : 'in',
        body,
        timestamp: parseTimestamp(node) || Date.now(),
        waId: dataId,
      });
    }

    if (batch.length > 0) {
      console.log(`[WasapPanel] Historial: ${batch.length} msgs de "${chatName}"`);
      sendBatch(batch);
    }
  } catch (err) {
    console.error('[WasapPanel] Error capturando historial:', err.message);
  }
}

setInterval(() => {
  const chatOpen      = !!document.querySelector(SELECTORS.chatHeader);
  const containerGone = currentContainer && !document.contains(currentContainer);

  if (chatOpen && (!observer || containerGone)) {
    console.log('[WasapPanel] Chat detectado, enganchando observer...');
    attachObserver();
  } else if (!chatOpen && observer) {
    observer.disconnect();
    observer = null;
    currentContainer = null;
  }
}, 3000);

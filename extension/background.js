const API_BASE  = 'https://panel.hosteriaamerica.com';
const API_KEY   = '48454d00e4c9a63acad716afd6c23b3c368047f4ddf30a6a352d81a46f052817';

const API_URL   = `${API_BASE}/api/message`;
const BATCH_URL = `${API_BASE}/api/messages/batch`;

const HEADERS = {
  'Content-Type': 'application/json',
  'X-Api-Key':    API_KEY,
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'WASAP_MESSAGE') {
    fetch(API_URL, {
      method:  'POST',
      headers: HEADERS,
      body:    JSON.stringify(msg.data),
    }).catch((err) => console.error('[WasapPanel] Error enviando mensaje:', err.message));
  }

  if (msg.type === 'WASAP_BATCH') {
    fetch(BATCH_URL, {
      method:  'POST',
      headers: HEADERS,
      body:    JSON.stringify({ messages: msg.data }),
    }).catch((err) => console.error('[WasapPanel] Error enviando batch:', err.message));
  }
});

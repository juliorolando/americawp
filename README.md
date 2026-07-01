# WasapPanel — Monitor de WhatsApp Web para recepción hotelera

Captura automáticamente mensajes de WhatsApp Web mediante una extensión de Chrome y los registra en una base de datos SQLite expuesta en un panel web local.

## Arquitectura

```
[Chrome + WhatsApp Web]
   └── extension/content.js     ← MutationObserver: detecta mensajes
          │
          └── extension/background.js  ← Service Worker: reenvía por HTTP
                    │
                    ▼
         POST /api/message  (con X-Api-Key)
                    │
         [Panel Express — panel.js]
                    │
              wasappanel.db (SQLite)
                    │
              http://localhost:3500
```

- La extensión vive en el navegador; no hace falta Puppeteer ni Chromium adicional.
- El panel es un servidor Node.js local (o remoto) que expone la API y la UI.

---

## Requisitos

- Node.js 22+ (usa `--experimental-sqlite` nativo)
- Chrome, Edge o cualquier navegador basado en Chromium

---

## 1. Configurar el panel

### 1.1 Instalar dependencias

```bash
npm install
```

### 1.2 Crear el archivo `.env`

Copiar el ejemplo y completar con los valores reales:

```env
# Usuarios del panel (JSON array)
PANEL_USERS=[{"user":"admin","pass":"TU_PASS_ADMIN"},{"user":"recepcion","pass":"TU_PASS_RECEPCION"}]

# Secreto para las sesiones web
SESSION_SECRET=cadena-aleatoria-larga

# API key que usa la extensión para autenticarse (debe coincidir con background.js)
API_KEY=tu-api-key-aqui

# Puerto del servidor (default: 3500)
PORT=3500

# API key de Groq para el resumen automático con IA (opcional)
GROQ_API_KEY=tu-groq-api-key
```

### 1.3 Arrancar el panel

```bash
npm run panel
```

Panel disponible en: **http://localhost:3500**

La primera vez se crea `wasappanel.db` automáticamente.

---

## 2. Cargar la extensión en Chrome

1. Abrir Chrome y navegar a `chrome://extensions`
2. Activar **"Modo desarrollador"** (toggle arriba a la derecha)
3. Hacer clic en **"Cargar descomprimida"**
4. Seleccionar la carpeta `extension/` de este repositorio
5. La extensión queda activa — se llama **Monitor**

> La extensión solo actúa en `https://web.whatsapp.com/*` y no requiere ninguna interacción manual una vez cargada.

---

## 3. Configurar la extensión

El archivo `extension/background.js` tiene la URL del panel y la API key hardcodeadas:

```js
const API_BASE = 'https://panel.hosteriaamerica.com';  // ← cambiar si el panel corre local
const API_KEY  = 'tu-api-key-aqui';                   // ← debe coincidir con .env API_KEY
```

**Si el panel corre en local**, cambiar `API_BASE` a:

```js
const API_BASE = 'http://localhost:3500';
```

Luego de cualquier cambio en la extensión, volver a `chrome://extensions` y hacer clic en el ícono de recarga de la extensión.

---

## 4. Usar el sistema

1. Arrancar el panel: `npm run panel`
2. Abrir **https://web.whatsapp.com** en Chrome
3. Iniciar sesión con el QR (solo la primera vez por perfil de Chrome)
4. Abrir cualquier chat — la extensión empieza a capturar mensajes automáticamente
5. Revisar los registros en **http://localhost:3500**

La consola de Chrome (DevTools → pestaña del service worker de la extensión) muestra logs como:

```
[WasapPanel] Observer activo en: "[data-testid="conversation-panel-messages"]"
[WasapPanel] [IN] Juan Pérez: Hola, tienen habitación disponible?
[WasapPanel] Historial: 12 msgs de "Juan Pérez"
```

---

## Panel web

| Ruta | Descripción | Rol requerido |
|------|-------------|---------------|
| `/` | Lista de chats ordenados por actividad | Cualquier usuario |
| `/chat/:id` | Conversación completa con estilo tipo WhatsApp | Cualquier usuario |
| `/export/:id` | Descarga `.txt` con toda la conversación | Cualquier usuario |
| `/pendientes` | Chats con estado "pendiente" o "en proceso" | Cualquier usuario |
| `/buscar` | Búsqueda de texto en todos los mensajes | Cualquier usuario |
| `/contactos` | Lista de contactos registrados | Cualquier usuario |
| `/estadisticas` | Actividad por hora/día, filtros por fecha | Cualquier usuario |
| `/ocultos` | Chats ocultos (solo admin puede restaurar) | Admin |

### Resumen automático con IA

En la vista de cada chat hay un botón **"Resumir con IA"**. Usa Groq (llama-3.1-8b-instant) para generar un resumen en español de la sesión actual. Requiere `GROQ_API_KEY` en el `.env`.

---

## Roles de usuario

- **admin** — acceso completo: puede ocultar/restaurar chats, limpiar la base de datos
- **recepcion** — acceso solo lectura al panel y chats

Los usuarios se configuran en `PANEL_USERS` dentro del `.env`.

---

## Ajustar selectores si WhatsApp cambia su DOM

WhatsApp Web usa clases CSS ofuscadas que pueden cambiar. Los selectores están al inicio de `extension/content.js` en el objeto `SELECTORS`. Los más estables son los `data-testid`:

| Elemento | Selector | Por qué es estable |
|----------|----------|-------------------|
| Header del chat | `[data-testid="conversation-info-header"]` | Atributo `data-testid` |
| Título del chat | `[data-testid="conversation-info-header-chat-title"]` | Atributo `data-testid` |
| Contenedor mensajes | `[data-testid="conversation-panel-messages"]` | Atributo `data-testid` |
| Nodo de mensaje | `div[data-id]` | Atributo `data-id` |
| Texto del mensaje | `span.selectable-text` | Clase semántica estable |

### Proceso para re-ajustar

1. Abrir DevTools en Chrome (F12) con WhatsApp Web abierto
2. Inspeccionar los elementos afectados
3. Buscar atributos `data-testid`, `data-id`, `role` — preferir estos sobre clases
4. Actualizar las constantes en `SELECTORS` al inicio de `extension/content.js`
5. Recargar la extensión en `chrome://extensions`

---

## Estructura de archivos

```
wasappanel/
├── panel.js            # Servidor Express (panel web + API)
├── db.js               # SQLite: inicialización y helpers
├── views/
│   ├── index.ejs       # Lista de chats
│   ├── chat.ejs        # Vista de conversación
│   ├── pendientes.ejs  # Chats pendientes
│   ├── buscar.ejs      # Búsqueda
│   ├── contactos.ejs   # Contactos
│   ├── estadisticas.ejs# Estadísticas
│   ├── ocultos.ejs     # Chats ocultos (admin)
│   └── login.ejs       # Login
├── extension/
│   ├── manifest.json   # Manifest V3 de la extensión
│   ├── content.js      # Script inyectado en WhatsApp Web
│   └── background.js   # Service Worker: envía mensajes al panel
├── .env                # Variables de entorno (no commitear)
├── wasappanel.db       # Base de datos SQLite (no commitear)
└── package.json
```

---

## Notas de privacidad y seguridad

- La base de datos es local, los mensajes nunca salen del servidor salvo para el resumen IA (Groq).
- `.gitignore` excluye `wasappanel.db` para que no se suba accidentalmente.
- La API key en `background.js` no es un secreto crítico (es pública en el código de la extensión), pero evita recibir mensajes de fuentes no autorizadas.
- Las sesiones del panel duran 8 horas.

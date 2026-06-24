# WasapPanel — Monitor de WhatsApp Web para recepción hotelera

Registra automáticamente los mensajes de WhatsApp Web en una base de datos SQLite y los expone en un panel web local.

## Requisitos

- Node.js 18+
- npm

## Instalación

```bash
npm install
```

## Uso

### Arrancar solo el monitor (Puppeteer)

```bash
npm run monitor
```

Abre Chromium con WhatsApp Web. La primera vez escanear el QR con el celular. Las sesiones siguientes se retoman automáticamente desde `./whatsapp-session/`.

### Arrancar solo el panel web

```bash
npm run panel
```

Panel disponible en [http://localhost:3500](http://localhost:3500)

### Arrancar ambos a la vez

```bash
npm run dev
```

## Panel web

| Ruta | Descripción |
|------|-------------|
| `/` | Lista de chats ordenados por actividad reciente |
| `/chat/:id` | Conversación completa con estilo tipo WhatsApp |
| `/export/:id` | Descarga `.txt` con toda la conversación |

## Cómo ajustar selectores si WhatsApp cambia su DOM

WhatsApp Web usa clases CSS ofuscadas que pueden cambiar sin aviso. Los selectores más estables son:

| Elemento | Selector actual | Por qué es estable |
|----------|----------------|-------------------|
| Header del chat activo | `header [data-testid="conversation-info-header-chat-title"]` | Atributo `data-testid` |
| Contenedor de mensajes | `#main [data-testid="msg-container"]` o `div[role="application"]` dentro de `#main` | Role ARIA |
| Nodo de mensaje individual | `div[data-id]` dentro del contenedor | Atributo `data-id` |
| Texto del mensaje | `span.selectable-text` | Clase semántica poco ofuscada |
| Timestamp visible | `[data-testid="msg-meta"] span` | Atributo `data-testid` |
| Dirección (enviado) | Presencia de `[data-testid="msg-dbl-check"]` o clase `message-out` en el ancestro | Clase funcional |

### Proceso para re-ajustar selectores

1. Arrancar `npm run monitor` — Chromium queda visible
2. Abrir DevTools en Chromium (F12)
3. Inspeccionar los elementos deseados
4. Buscar atributos `data-testid`, `data-id`, `role` — preferir estos sobre clases
5. Actualizar las constantes `SELECTORS` al inicio de `monitor.js`
6. Reiniciar `npm run monitor`

Los logs de consola muestran cada mensaje capturado:

```
[14:32:01] [IN]  Chat: Juan Pérez | Msg: Hola, tienen habitación disponible para mañana?
[14:32:45] [OUT] Chat: Juan Pérez | Msg: Sí, tenemos disponibilidad. ¿Para cuántas personas?
```

Si ves `[SELECTOR NO ENCONTRADO]` en los logs, ese selector necesita ajuste.

## Estructura de archivos

```
wasappanel/
├── monitor.js          # Proceso Puppeteer (captura mensajes)
├── panel.js            # Servidor Express (panel web)
├── db.js               # SQLite: inicialización y helpers
├── views/
│   ├── index.ejs       # Lista de chats
│   └── chat.ejs        # Vista de conversación
├── whatsapp-session/   # Sesión persistida (ignorada en git)
├── wasappanel.db       # Base de datos SQLite (ignorada en git)
└── package.json
```

## Notas de privacidad

- La base de datos y la sesión de WhatsApp son locales, nunca salen del servidor.
- `.gitignore` excluye `whatsapp-session/` y `*.db` para que no se suban accidentalmente.

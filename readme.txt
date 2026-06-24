Construí un sistema de registro de WhatsApp Web para la recepción de un hotel. Stack: Node.js + Puppeteer + SQLite + Express + EJS. Una sola repo, dos procesos: el monitor de Puppeteer y el panel web Express.

## Arquitectura

### Proceso 1: monitor.js (Puppeteer)
- Lanzar Chromium en modo HEADED (visible, no headless) para que el empleado pueda usar WhatsApp Web normalmente
- Persistir la sesión de WhatsApp usando `userDataDir: ./whatsapp-session` para no escanear QR cada vez
- Una vez que WhatsApp Web carga y hay sesión activa, inyectar via `page.evaluate()` un MutationObserver que observe el panel de mensajes del chat activo
- El observer debe detectar nodos de mensajes nuevos (tanto entrantes como salientes) y extraer:
  - Texto del mensaje
  - Timestamp (leerlo del DOM o usar Date.now() como fallback)
  - Dirección: "in" (mensaje recibido) o "out" (mensaje enviado)
  - Nombre/número del chat activo (leer del header del chat)
- Usar `page.exposeFunction('saveMessage', fn)` para que el código del browser pueda llamar al proceso Node y guardar en SQLite
- Cuando el usuario cambia de chat, re-inyectar el observer en el nuevo chat y registrar que el chat activo cambió
- Manejar reconexiones: si WhatsApp Web se desconecta o recarga, volver a inyectar el observer

### Base de datos: SQLite con better-sqlite3
Tablas:
- `chats`: id, phone_or_name (texto del header del chat), first_seen, last_seen
- `messages`: id, chat_id (FK), direction ("in"/"out"), body (texto), timestamp (unix ms), created_at

### Proceso 2: panel.js (Express + EJS)
Puerto 3500. Panel web simple para revisar los registros.

Rutas:
- GET / → lista de chats ordenados por last_seen DESC, mostrando nombre, cantidad de mensajes y último mensaje
- GET /chat/:id → conversación completa de ese chat, mensajes en orden cronológico, con estilo tipo WhatsApp (mensajes propios a la derecha, recibidos a la izquierda)
- GET /export/:id → descarga un .txt con toda la conversación del chat (para adjuntar a un expediente si hace falta)

Diseño del panel: limpio y funcional, sin librerías externas CSS. Solo HTML/CSS inline en los EJS. Verde WhatsApp (#25D366) como color de acento. Mobile-friendly porque lo puedo revisar desde el celular.

## Scripts en package.json
- `npm run monitor` → arranca monitor.js
- `npm run panel` → arranca panel.js
- `npm run dev` → arranca ambos con concurrently

## Consideraciones técnicas importantes
- Los selectores CSS de WhatsApp Web son ofuscados y cambian. Usar atributos data-* o roles ARIA que son más estables. Si no hay selectores estables, loguear en consola los nodos detectados para poder ajustar
- El MutationObserver debe observar el contenedor de mensajes del chat activo, no el DOM completo (performance)
- Evitar duplicados: cada mensaje que llega debe chequearse contra los últimos N mensajes en SQLite antes de insertar (comparar body + timestamp aproximado)
- Si el panel de chat no está abierto (está en la vista de lista de chats), pausar la observación
- Agregar logs en consola de monitor.js con timestamp para cada mensaje capturado: `[HH:MM:SS] [IN/OUT] Chat: X | Msg: Y`

## Archivos a crear
- monitor.js
- panel.js  
- db.js (inicialización y helpers de SQLite)
- views/index.ejs
- views/chat.ejs
- package.json
- .gitignore (ignorar whatsapp-session/ y *.db)
- README.md con instrucciones de uso y cómo ajustar selectores si WhatsApp cambia su DOM

Empezá por db.js y el README, luego monitor.js, luego el panel.
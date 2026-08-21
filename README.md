# WOBA Copilot — Core

Esqueleto conversacional del asistente administrativo para el grupo de 3 empresas (WOBA/BAE, Footprint, eWorks).

Este repo contiene únicamente el **core**: recepción de mensajes de Telegram, envío del contexto a Claude, y respuesta al usuario. Los módulos de negocio (cashflow, fiscal, documental, onboarding...) se irán añadiendo en `/modules`.

## Estructura

```
/core
  /telegram    -> cliente Telegram (recibir/enviar mensajes vía Bot API, fetch directo)
  /claude      -> cliente de la API de Anthropic (Claude)
  /knowledge   -> carga /docs/responsabilidades.md como contexto del sistema
/modules       -> vacío por ahora (futuros módulos de negocio)
/docs
  responsabilidades.md -> documento de responsabilidades del grupo (contexto para Claude)
/src
  server.ts    -> servidor Express con el endpoint POST /webhook/telegram
```

## Requisitos

- Node.js >= 18
- Un bot de Telegram creado con [@BotFather](https://t.me/BotFather) (necesitas el token)
- Una API key de Anthropic (https://console.anthropic.com)

## Instalación

```bash
npm install
```

Copia el archivo de variables de entorno de ejemplo y rellénalo:

```bash
cp .env.example .env
```

Variables necesarias en `.env`:

- `TELEGRAM_BOT_TOKEN` — token del bot obtenido de BotFather
- `ANTHROPIC_API_KEY` — API key de Anthropic
- `PORT` — puerto local (por defecto 3000)

## Correr en local

```bash
npm run dev
```

Esto levanta el servidor con recarga automática (`tsx watch`) en `http://localhost:3000`.

Puedes comprobar que está vivo con:

```bash
curl http://localhost:3000/health
```

### Probar el webhook en local sin exponerlo a internet

Puedes simular un update de Telegram directamente con `curl`:

```bash
curl -X POST http://localhost:3000/webhook/telegram \
  -H "Content-Type: application/json" \
  -d '{
    "update_id": 1,
    "message": {
      "message_id": 1,
      "date": 0,
      "chat": { "id": 123456789, "type": "private" },
      "from": { "id": 123456789, "is_bot": false, "username": "test" },
      "text": "Hola, ¿qué puedes hacer?"
    }
  }'
```

Ojo: como el envío de la respuesta usa tu `TELEGRAM_BOT_TOKEN` real, esto intentará enviar el mensaje a ese `chat_id` de verdad. Para pruebas puramente locales sin tocar Telegram, usa tu propio `chat_id` (puedes obtenerlo escribiéndole a tu bot y consultando `https://api.telegram.org/bot<TOKEN>/getUpdates`).

## Configurar el webhook de Telegram (producción / Railway)

Telegram necesita una URL pública HTTPS para enviarte los mensajes. Una vez desplegado el proyecto (por ejemplo en Railway) y con el dominio público asignado:

1. Despliega el proyecto y anota la URL pública, por ejemplo:
   `https://woba-copilot-production.up.railway.app`

2. Configura las variables de entorno en Railway (`TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`).

3. Registra el webhook en Telegram apuntando a `/webhook/telegram`:

   ```bash
   curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{"url": "https://<tu-dominio-publico>/webhook/telegram"}'
   ```

4. Verifica que quedó bien configurado:

   ```bash
   curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
   ```

5. Escríbele al bot por Telegram — el mensaje debería llegar al webhook, procesarse con Claude usando el contexto de `/docs/responsabilidades.md`, y recibir la respuesta en el chat.

Para quitar el webhook (por ejemplo, si vuelves a desarrollo local con polling manual):

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/deleteWebhook"
```

## Build de producción

```bash
npm run build
npm start
```

## Base de conocimiento

El archivo [`docs/responsabilidades.md`](docs/responsabilidades.md) se carga automáticamente como parte del *system prompt* que se envía a Claude en cada mensaje. Actualízalo con el contenido real del documento de responsabilidades del grupo; no requiere cambios de código ni redeploy si solo editas su contenido en el mismo entorno desplegado (aunque en Railway sí necesitarás redeploy para que el cambio se refleje, salvo que se monte como volumen externo).

## Próximos pasos (fuera de alcance de esta sesión)

- Módulos de negocio en `/modules` (cashflow, fiscal, documental, onboarding)
- Integraciones con Holded, Google Drive, etc.
- Persistencia de conversaciones / memoria a largo plazo

import type { IncomingMessage, InlineKeyboardButton, TelegramUpdate } from "./types";

const TELEGRAM_API_BASE = "https://api.telegram.org";

function getBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("Falta la variable de entorno TELEGRAM_BOT_TOKEN");
  }
  return token;
}

/**
 * Extrae un mensaje entrante "utilizable" de un update de Telegram.
 * Devuelve null si el update no contiene un mensaje de texto (ej. edición, sticker, etc.).
 */
export function parseIncomingUpdate(update: TelegramUpdate): IncomingMessage | null {
  const message = update.message;
  if (!message || typeof message.text !== "string") {
    return null;
  }

  return {
    chatId: message.chat.id,
    text: message.text,
    fromUsername: message.from?.username,
  };
}

/**
 * Envía un mensaje de texto a un chat de Telegram usando la Bot API (sendMessage).
 */
export async function sendTelegramMessage(chatId: number, text: string): Promise<void> {
  const token = getBotToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Error enviando mensaje a Telegram (${response.status}): ${body}`);
  }
}

/**
 * Envía un mensaje con botones inline (teclado en línea). Cada fila de `buttons`
 * se renderiza como una fila de botones bajo el mensaje.
 */
export async function sendTelegramMessageWithButtons(
  chatId: number,
  text: string,
  buttons: InlineKeyboardButton[][]
): Promise<number> {
  const token = getBotToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: { inline_keyboard: buttons },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Error enviando mensaje con botones a Telegram (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { result: { message_id: number } };
  return data.result.message_id;
}

/**
 * Responde a un callback_query (pulsación de botón inline) para que Telegram
 * quite el estado de "cargando" del botón. `text` es opcional (toast breve).
 */
export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  const token = getBotToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/answerCallbackQuery`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Error respondiendo callback_query a Telegram (${response.status}): ${body}`);
  }
}

/**
 * Edita el texto de un mensaje ya enviado y opcionalmente reemplaza sus botones
 * (pasar un array vacío quita los botones; omitir `buttons` los deja igual).
 */
export async function editTelegramMessage(
  chatId: number,
  messageId: number,
  text: string,
  buttons?: InlineKeyboardButton[][]
): Promise<void> {
  const token = getBotToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/editMessageText`;

  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
  };

  if (buttons !== undefined) {
    body.reply_markup = { inline_keyboard: buttons };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Error editando mensaje de Telegram (${response.status}): ${errBody}`);
  }
}

/**
 * Registra la URL del webhook en Telegram (útil para configurar el bot tras el deploy).
 */
export async function setTelegramWebhook(webhookUrl: string): Promise<void> {
  const token = getBotToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/setWebhook`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Error configurando el webhook de Telegram (${response.status}): ${body}`);
  }
}

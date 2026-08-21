import type { IncomingMessage, TelegramUpdate } from "./types";

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

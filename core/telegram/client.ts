import type { IncomingMessage, InlineKeyboardButton, TelegramUpdate } from "./types";
import { registrarMensajeSaliente } from "../claude/conversationStore";

const TELEGRAM_API_BASE = "https://api.telegram.org";

function getBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("Falta la variable de entorno TELEGRAM_BOT_TOKEN");
  }
  return token;
}

// Causa raíz real, encontrada en vivo (2026-09-02): "el Chat está pegado"
// tras /revisarcorreo — el fetch a Telegram no tenía timeout, así que un
// blip de red dejaba la promesa sin resolver NI rechazar para siempre, y el
// .catch() que avisa el error nunca llegaba a dispararse. Mismo timeout que
// core/google/globalOptions.ts, mismo motivo.
const TIMEOUT_MS = 20_000;

/**
 * fetch() con reintento SOLO para fallos de red (fetch que ni siquiera
 * consigue conectar — ETIMEDOUT, ECONNRESET, DNS, o ahora un timeout propio —
 * no respuestas HTTP de error, esas se propagan tal cual en el primer
 * intento). Verificado en vivo que esto ocurre de verdad: un ETIMEDOUT real
 * entre Railway y api.telegram.org tumbó un guardado de captura ("TypeError:
 * fetch failed ... ETIMEDOUT") obligando al usuario a reescribir el mensaje.
 * 2 reintentos con espera corta — un blip de red suele resolverse en el
 * segundo intento; si persiste, el error real se deja propagar tal cual.
 */
async function fetchConReintento(url: string, init: RequestInit, intentos = 3): Promise<Response> {
  let ultimoError: unknown;
  for (let intento = 1; intento <= intentos; intento++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      ultimoError = error;
      if (intento < intentos) {
        await new Promise((resolve) => setTimeout(resolve, 500 * intento));
      }
    }
  }
  throw ultimoError;
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

  const nombre = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ");

  return {
    chatId: message.chat.id,
    text: message.text,
    fromUsername: message.from?.username,
    fromNombre: nombre || undefined,
  };
}

/**
 * Envía la acción "escribiendo..." (mismo indicador nativo de cualquier chat
 * de Telegram) — Telegram la muestra ~5 segundos y luego la esconde sola, así
 * que hay que reenviarla mientras dure el procesamiento (ver
 * iniciarIndicadorEscribiendo). Falla en silencio: nunca debe tumbar el flujo
 * real por un problema con un indicador visual.
 */
async function sendChatAction(chatId: number, action: "typing"): Promise<void> {
  try {
    const token = getBotToken();
    const url = `${TELEGRAM_API_BASE}/bot${token}/sendChatAction`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    console.error("[telegram] Error enviando indicador de 'escribiendo' (no crítico):", error);
  }
}

/**
 * Mantiene el indicador "escribiendo..." activo en un chat mientras dure una
 * operación larga (ej. el loop de tool-use de askClaude) — se reenvía cada 4s
 * porque Telegram lo esconde solo a los ~5s. Devuelve una función para
 * detenerlo; SIEMPRE debe llamarse (en un finally) cuando termine la
 * operación, incluso si falló.
 */
export function iniciarIndicadorEscribiendo(chatId: number): () => void {
  sendChatAction(chatId, "typing").catch(() => {});
  const intervalo = setInterval(() => {
    sendChatAction(chatId, "typing").catch(() => {});
  }, 4000);

  return () => clearInterval(intervalo);
}

/**
 * Envía un archivo (Buffer) como documento a un chat de Telegram. Se usa para
 * entregar reportes generados (Excel/PDF) directamente en el chat — el envío
 * a un chat ya autorizado no requiere botón de aprobación aparte, es
 * equivalente a responder una pregunta con un archivo en vez de texto.
 */
export async function sendTelegramDocument(
  chatId: number,
  buffer: Buffer,
  filename: string,
  caption?: string
): Promise<void> {
  const token = getBotToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/sendDocument`;

  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  form.append("document", new Blob([buffer]), filename);

  const response = await fetchConReintento(url, { method: "POST", body: form });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Error enviando documento a Telegram (${response.status}): ${body}`);
  }
}

/**
 * Envía un mensaje de texto a un chat de Telegram usando la Bot API (sendMessage).
 */
export async function sendTelegramMessage(chatId: number, text: string): Promise<void> {
  const token = getBotToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;

  const response = await fetchConReintento(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: formatearParaTelegram(text),
      parse_mode: "HTML",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Error enviando mensaje a Telegram (${response.status}): ${body}`);
  }

  // "Fire and forget" — no bloquea el envío real por la latencia de Sheets.
  // Ver registrarMensajeSaliente: pedido explícito de Carlos, cualquier
  // pregunta/aviso que el asistente mande (venga de un cron, un callback, o
  // el chat normal) debe quedar en el mismo historial que usa askClaude.
  // Se guarda el texto ORIGINAL (markdown crudo, sin tags HTML) — es lo que
  // Claude espera ver si retoma el hilo, no el marcado pensado para Telegram.
  registrarMensajeSaliente(chatId, text).catch((error) =>
    console.error("[telegram/client] Error registrando mensaje saliente en el historial:", error)
  );
}

const MENSAJE_TRABAJANDO = "⏳ Trabajando en tu consulta...";

/**
 * Envía un mensaje real de "Trabajando..." — a diferencia del indicador
 * nativo "escribiendo..." (sendChatAction), Telegram no deja personalizar
 * ese texto ni controlarlo más allá de reenviarlo cada pocos segundos.
 * Pedido explícito: que se vea "trabajando" en el chat, en el mismo lugar
 * de la consulta — este mensaje real cumple eso y además se puede EDITAR
 * en el mismo lugar con la respuesta final (ver entregarRespuestaTrasTrabajar),
 * a diferencia del indicador nativo que solo desaparece. Devuelve su
 * message_id, o undefined si el envío falla — nunca debe tumbar el flujo
 * real por un problema de este aviso.
 */
export async function avisarTrabajando(chatId: number): Promise<number | undefined> {
  try {
    const token = getBotToken();
    const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;

    const response = await fetchConReintento(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: MENSAJE_TRABAJANDO }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Error enviando aviso de 'trabajando' (${response.status}): ${body}`);
    }

    const data = (await response.json()) as { result: { message_id: number } };
    return data.result.message_id;
  } catch (error) {
    console.error("[telegram] Error enviando aviso de 'trabajando' (no crítico):", error);
    return undefined;
  }
}

/**
 * Entrega la respuesta final EDITANDO en el mismo lugar el mensaje de
 * "Trabajando..." (ver avisarTrabajando) — así el usuario ve el mismo
 * mensaje pasar de "trabajando" a la respuesta real, sin un mensaje nuevo
 * aparte. Si no hubo mensaje de "trabajando" (falló al enviarlo) o editarlo
 * falla por lo que sea, cae a mandar un mensaje nuevo — la respuesta real
 * nunca se pierde por un problema de este aviso.
 */
export async function entregarRespuestaTrasTrabajar(
  chatId: number,
  mensajeTrabajandoId: number | undefined,
  texto: string
): Promise<void> {
  if (mensajeTrabajandoId !== undefined) {
    try {
      await editTelegramMessageSmart(chatId, mensajeTrabajandoId, texto);
      return;
    } catch (error) {
      console.error("[telegram] Error editando el aviso de 'trabajando' con la respuesta final (no crítico):", error);
    }
  }
  await sendTelegramMessageSmart(chatId, texto);
}

/**
 * Envía un mensaje con botones inline (teclado en línea). Cada fila de `buttons`
 * se renderiza como una fila de botones bajo el mensaje.
 */
/**
 * Pedido explícito de Carlos, tras varios casos reales (propuestas de
 * gasto/documento con botones que ocupaban toda la pantalla, obligando a
 * hacer scroll — "me sigues enviando mensajes... que no son colapsables"):
 * cualquier mensaje CON botones que sea largo se manda colapsado, igual
 * criterio y mismo umbral (UMBRAL_COLAPSABLE) que sendTelegramMessageSmart
 * ya aplicaba a los mensajes SIN botones. Antes esta función nunca
 * colapsaba nada, así que cualquier llamador que la usara directo (la
 * mayoría de las propuestas del sistema: clasificación de documentos,
 * gastos, acciones de correo) se salteaba el colapso aunque el texto fuera
 * larguísimo — centralizar el chequeo acá, en vez de exigir que cada
 * llamador use sendTelegramMessageSmart, corrige todos esos casos de una
 * sola vez.
 */
export async function sendTelegramMessageWithButtons(
  chatId: number,
  text: string,
  buttons: InlineKeyboardButton[][]
): Promise<number> {
  if (text.length > UMBRAL_COLAPSABLE) {
    return sendTelegramMessageExpandable(chatId, tituloAutomatico(text), text, buttons);
  }

  const token = getBotToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;

  const response = await fetchConReintento(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: formatearParaTelegram(text),
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Error enviando mensaje con botones a Telegram (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { result: { message_id: number } };

  registrarMensajeSaliente(chatId, text).catch((error) =>
    console.error("[telegram/client] Error registrando mensaje saliente en el historial:", error)
  );

  return data.result.message_id;
}

function escaparHTML(texto: string): string {
  return texto.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Encontrado en auditoría (2026-09-02), visible en capturas reales de
 * Carlos: NINGÚN envío de este archivo pasaba `parse_mode` a Telegram, así
 * que el markdown que Claude produce naturalmente (**negrita**) se veía
 * como asteriscos literales en el chat real — no era un problema nuevo del
 * formato colapsable, ya pasaba en TODOS los mensajes desde siempre. Esta
 * función convierte el único patrón de markdown que este proyecto usa de
 * forma consistente (**negrita**) al HTML real que Telegram sabe renderizar;
 * el resto del texto se escapa como HTML normal, así que cualquier
 * '<'/'>'/'&' real en el contenido (un monto, un email) nunca rompe el
 * parseo. Se usa en TODOS los envíos/ediciones de este archivo (parse_mode
 * HTML en todos, no solo en los colapsables) para que el texto se vea
 * consistente en cualquier mensaje que mande Wobi.
 */
function formatearParaTelegram(texto: string): string {
  return escaparHTML(texto).replace(/\*\*([^*]+?)\*\*/g, "<b>$1</b>");
}

/** Para títulos que ya van envueltos en <b>...</b> por fuera — quita los marcadores ** en vez de convertirlos (evitar <b><b>). */
function limpiarTitulo(texto: string): string {
  return escaparHTML(texto).replace(/\*\*/g, "");
}

/**
 * Pedido explícito de Carlos, tras un caso real (una recomendación de
 * anotación de cashflow tan larga que obligaba a hacer scroll constante):
 * "es posible que cada una venga con un título... y que sea desplegable de
 * tal manera que yo pueda haber varias al mismo tiempo e ir decidiendo cuál
 * voy a gestionar, sin tener que estar dando scroll". Usa el "expandable
 * blockquote" nativo de Telegram (`<blockquote expandable>`, parse_mode
 * HTML — verificado contra la documentación oficial 2026-09-02, entity type
 * `expandable_blockquote`, colapsado por defecto) — el título queda SIEMPRE
 * visible en negrita, y el cuerpo largo queda colapsado hasta que la
 * persona lo toca, así varios mensajes de este tipo caben en pantalla a la
 * vez sin scroll. `titulo` y `cuerpo` se escapan como HTML (nunca se
 * interpretan como tags) — si alguno trae '<', '>' o '&' reales (ej. un
 * monto "< 5.000"), no rompe el parseo.
 */
export async function sendTelegramMessageExpandable(
  chatId: number,
  titulo: string,
  cuerpo: string,
  buttons?: InlineKeyboardButton[][]
): Promise<number> {
  const token = getBotToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;

  const text = `<b>${limpiarTitulo(titulo)}</b>\n<blockquote expandable>${formatearParaTelegram(cuerpo)}</blockquote>`;

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };

  const response = await fetchConReintento(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const respBody = await response.text();
    throw new Error(`Error enviando mensaje expandible a Telegram (${response.status}): ${respBody}`);
  }

  const data = (await response.json()) as { result: { message_id: number } };

  // Se guarda en el historial en texto plano (sin las tags HTML) — es lo
  // mismo que vería la persona si expandiera el bloque, y evita que el
  // historial de conversación quede lleno de marcado que Claude no necesita.
  registrarMensajeSaliente(chatId, `${titulo}\n\n${cuerpo}`).catch((error) =>
    console.error("[telegram/client] Error registrando mensaje saliente en el historial:", error)
  );

  return data.result.message_id;
}

// Pedido explícito de Carlos: "asegúrate que todo se pueda colapsar
// incluyendo tus respuestas, así que no quedan textos tan largos ocupando
// el scroll" — esto no es solo para las anotaciones de cashflow (donde ya
// hay un título natural, la ubicación), sino para CUALQUIER respuesta larga
// que mande Wobi, incluidas las respuestas normales del chat, que no
// tienen un título natural. Un texto corto (un saludo, un dato de una
// línea) NO debe colapsarse — sería peor UX obligar a tocar algo tan
// corto — así que solo se activa sobre un umbral real de longitud.
const UMBRAL_COLAPSABLE = 400;

/** Primera línea (o los primeros `maxChars`) del texto — usado como título cuando no hay uno natural (ej. respuestas de chat normal). */
function tituloAutomatico(texto: string, maxChars = 70): string {
  const primeraLinea = texto.split("\n")[0].trim();
  if (primeraLinea.length <= maxChars) return primeraLinea || "Respuesta";
  return primeraLinea.slice(0, maxChars).trim() + "…";
}

/**
 * Envía un mensaje nuevo, colapsado automáticamente si es largo (ver
 * UMBRAL_COLAPSABLE) — para texto corto, se manda igual que
 * sendTelegramMessage/sendTelegramMessageWithButtons, sin ningún cambio
 * visual. Devuelve siempre el message_id (a diferencia de
 * sendTelegramMessage, que no lo necesitaba antes de existir esta función).
 */
export async function sendTelegramMessageSmart(
  chatId: number,
  texto: string,
  buttons?: InlineKeyboardButton[][],
  titulo?: string
): Promise<number> {
  if (texto.length <= UMBRAL_COLAPSABLE) {
    // "**titulo**" en vez de construir <b> a mano: formatearParaTelegram (ya
    // aplicado dentro de sendTelegramMessage/sendTelegramMessageWithButtons)
    // lo convierte igual que cualquier negrita que venga de Claude — un solo
    // camino de formato, no dos implementaciones separadas.
    const textoConTitulo = titulo ? `**${titulo}**\n\n${texto}` : texto;
    return buttons
      ? sendTelegramMessageWithButtons(chatId, textoConTitulo, buttons)
      : sendTelegramMessagePlain(chatId, textoConTitulo);
  }

  return sendTelegramMessageExpandable(chatId, titulo || tituloAutomatico(texto), texto, buttons);
}

/** sendTelegramMessage pero devolviendo el message_id (necesario para sendTelegramMessageSmart sin botones). */
async function sendTelegramMessagePlain(chatId: number, text: string): Promise<number> {
  const token = getBotToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;

  const response = await fetchConReintento(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: formatearParaTelegram(text), parse_mode: "HTML" }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Error enviando mensaje a Telegram (${response.status}): ${body}`);
  }
  const data = (await response.json()) as { result: { message_id: number } };
  registrarMensajeSaliente(chatId, text).catch((error) =>
    console.error("[telegram/client] Error registrando mensaje saliente en el historial:", error)
  );
  return data.result.message_id;
}

/**
 * Responde a un callback_query (pulsación de botón inline) para que Telegram
 * quite el estado de "cargando" del botón. `text` es opcional (toast breve).
 */
export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  const token = getBotToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/answerCallbackQuery`;

  const response = await fetchConReintento(url, {
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
    text: formatearParaTelegram(text),
    parse_mode: "HTML",
  };

  if (buttons !== undefined) {
    body.reply_markup = { inline_keyboard: buttons };
  }

  const response = await fetchConReintento(url, {
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
 * Cambia SOLO los botones de un mensaje ya enviado, sin tocar su texto —
 * usa editMessageReplyMarkup (distinto de editMessageText), pedido
 * explícito de Carlos para el teclado de selección de acciones de gasto
 * (ver gastoTeclado.ts): marcar/desmarcar un check no debe reescribir ni
 * reformatear el texto original de la propuesta, solo repintar los botones.
 */
export async function editTelegramMessageReplyMarkup(
  chatId: number,
  messageId: number,
  buttons: InlineKeyboardButton[][]
): Promise<void> {
  const token = getBotToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/editMessageReplyMarkup`;

  const response = await fetchConReintento(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: buttons },
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    // Telegram devuelve 400 "message is not modified" cuando el teclado
    // mandado es idéntico al que ya está — no es un error real, pasa cada
    // vez que una selección vuelve al mismo estado que ya se había pintado
    // (ej. marcar y desmarcar el mismo check dos veces seguidas).
    if (response.status === 400 && /message is not modified/i.test(errBody)) return;
    throw new Error(`Error editando los botones de un mensaje de Telegram (${response.status}): ${errBody}`);
  }
}

/** Igual que editTelegramMessage, pero con título fijo + cuerpo largo colapsado — ver sendTelegramMessageExpandable. */
export async function editTelegramMessageExpandable(
  chatId: number,
  messageId: number,
  titulo: string,
  cuerpo: string,
  buttons?: InlineKeyboardButton[][]
): Promise<void> {
  const token = getBotToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/editMessageText`;

  const text = `<b>${limpiarTitulo(titulo)}</b>\n<blockquote expandable>${formatearParaTelegram(cuerpo)}</blockquote>`;

  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
  };

  if (buttons !== undefined) {
    body.reply_markup = { inline_keyboard: buttons };
  }

  const response = await fetchConReintento(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Error editando mensaje expandible de Telegram (${response.status}): ${errBody}`);
  }
}

/** Igual que sendTelegramMessageSmart pero editando un mensaje existente (ver entregarRespuestaTrasTrabajar). */
export async function editTelegramMessageSmart(
  chatId: number,
  messageId: number,
  texto: string,
  buttons?: InlineKeyboardButton[][],
  titulo?: string
): Promise<void> {
  if (texto.length <= UMBRAL_COLAPSABLE) {
    await editTelegramMessage(chatId, messageId, titulo ? `**${titulo}**\n\n${texto}` : texto, buttons);
    return;
  }
  await editTelegramMessageExpandable(chatId, messageId, titulo || tituloAutomatico(texto), texto, buttons);
}

export interface TelegramFileInfo {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

/**
 * Pide a Telegram la ruta de descarga (file_path) de un file_id. Válida solo
 * un tiempo limitado; hay que descargar poco después de llamarla.
 */
export async function getTelegramFile(fileId: string): Promise<TelegramFileInfo> {
  const token = getBotToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`;

  const response = await fetchConReintento(url, {});

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Error obteniendo el archivo de Telegram (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { result: TelegramFileInfo };
  return data.result;
}

/**
 * Descarga el contenido de un archivo de Telegram (dado su file_path, de
 * getTelegramFile) y devuelve los bytes crudos.
 */
export async function downloadTelegramFile(filePath: string): Promise<Buffer> {
  const token = getBotToken();
  const url = `${TELEGRAM_API_BASE}/file/bot${token}/${filePath}`;

  const response = await fetchConReintento(url, {});

  if (!response.ok) {
    throw new Error(`Error descargando el archivo de Telegram (${response.status}): ${url}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Registra la URL del webhook en Telegram (útil para configurar el bot tras el deploy).
 */
export async function setTelegramWebhook(webhookUrl: string): Promise<void> {
  const token = getBotToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/setWebhook`;

  const response = await fetchConReintento(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Error configurando el webhook de Telegram (${response.status}): ${body}`);
  }
}

export interface TelegramWebhookInfo {
  url: string;
  lastErrorMessage?: string;
  lastErrorDate?: number;
}

/** Consulta el estado real del webhook registrado en Telegram (para el panel de conexiones). */
export async function getTelegramWebhookInfo(): Promise<TelegramWebhookInfo> {
  const token = getBotToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/getWebhookInfo`;

  const response = await fetchConReintento(url, {});
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Error consultando el webhook de Telegram (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    result: { url: string; last_error_message?: string; last_error_date?: number };
  };

  return {
    url: data.result.url,
    lastErrorMessage: data.result.last_error_message,
    lastErrorDate: data.result.last_error_date,
  };
}

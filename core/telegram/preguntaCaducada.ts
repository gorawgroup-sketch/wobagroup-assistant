import { answerCallbackQuery, deleteTelegramMessage, editTelegramMessageReplyMarkup } from "./client";
import type { TelegramCallbackQuery } from "./types";

/**
 * Una pregunta con botones que ya no se puede procesar (expiró, ya se resolvió, la propuesta ya no existe) debe
 * desaparecer del chat: pedido de Carlos, que en el chat solo estén las preguntas activas. Antes, pulsar un botón
 * caducado solo mostraba un aviso y dejaba la pregunta muerta ahí, y si el aviso llegaba tarde se convertía en
 * una burbuja permanente más.
 */

/** Ventana en la que otra pulsación sobre el mismo mensaje indica que puede haber un procesamiento en curso. */
const VENTANA_PULSACIONES_MS = 5 * 60_000;
const pulsaciones = new Map<string, number[]>();

const claveMensaje = (chatId: number, messageId: number) => `${chatId}:${messageId}`;

/**
 * Registra una pulsación sobre un mensaje. Se llama una vez por callback, antes de despacharlo. Sirve para no borrar
 * un mensaje que otra pulsación (doble toque, dos usuarios) está procesando en este mismo momento: esa pulsación
 * terminará editándolo con su resultado, y borrarlo antes haría fallar esa edición.
 */
export function registrarPulsacionSobreMensaje(callback: TelegramCallbackQuery, ahora = Date.now()): void {
  const mensaje = callback.message;
  if (!mensaje) return;
  const llave = claveMensaje(mensaje.chat.id, mensaje.message_id);
  const recientes = (pulsaciones.get(llave) ?? []).filter((t) => ahora - t < VENTANA_PULSACIONES_MS);
  recientes.push(ahora);
  pulsaciones.set(llave, recientes);
  if (pulsaciones.size > 500) {
    for (const [otra, tiempos] of pulsaciones) {
      if (ahora - tiempos[tiempos.length - 1] >= VENTANA_PULSACIONES_MS) pulsaciones.delete(otra);
    }
  }
}

function hayPulsacionPreviaReciente(chatId: number, messageId: number, ahora: number): boolean {
  const recientes = (pulsaciones.get(claveMensaje(chatId, messageId)) ?? []).filter((t) => ahora - t < VENTANA_PULSACIONES_MS);
  // La última es la pulsación que se está atendiendo; cualquier otra anterior cuenta.
  return recientes.length > 1;
}

export interface DependenciasPreguntaCaducada {
  responder: (callbackQueryId: string, texto?: string) => Promise<void>;
  borrar: (chatId: number, messageId: number) => Promise<boolean>;
  quitarBotones: (chatId: number, messageId: number) => Promise<void>;
  ahora: () => number;
}

const dependencias: DependenciasPreguntaCaducada = {
  responder: answerCallbackQuery,
  borrar: deleteTelegramMessage,
  quitarBotones: (chatId, messageId) => editTelegramMessageReplyMarkup(chatId, messageId, []),
  ahora: Date.now,
};

/**
 * Avisa brevemente (toast) y retira del chat el mensaje de la pregunta que ya no está disponible. Si Telegram no deja
 * borrarlo (más de 48 h) le quita al menos los botones para que no parezca activo. Nunca lanza: es limpieza.
 */
export async function retirarPreguntaCaducada(
  callback: TelegramCallbackQuery,
  texto?: string,
  deps: DependenciasPreguntaCaducada = dependencias
): Promise<void> {
  try {
    await deps.responder(callback.id, texto);
  } catch (error) {
    console.error("[preguntaCaducada] No se pudo responder el callback_query (no crítico):", error instanceof Error ? error.message : error);
  }
  const mensaje = callback.message;
  if (!mensaje) return;
  const chatId = mensaje.chat.id;
  const messageId = mensaje.message_id;
  if (hayPulsacionPreviaReciente(chatId, messageId, deps.ahora())) return;
  try {
    if (await deps.borrar(chatId, messageId)) return;
    await deps.quitarBotones(chatId, messageId);
  } catch (error) {
    console.error("[preguntaCaducada] No se pudo retirar la pregunta caducada (no crítico):", error instanceof Error ? error.message : error);
  }
}

import { actualizarMessageIdGasto, type PropuestaGasto } from "./gastoProposalSheet";
import type { TelegramCallbackQuery } from "../telegram/types";

/**
 * El botón que se pulsa vive en un mensaje concreto; el id guardado en la propuesta puede ser el de una versión anterior
 * (la propuesta se reenvió con «Botones renovados», o la escritura del id nuevo falló por cuota de Sheets). Repintar el
 * teclado o cerrar el mensaje en el id guardado daba «message to edit not found» y el botón parecía no hacer nada
 * (Casa Peppe, 2026-10-06: «Crear (sin conciliar)» no se activaba). Los cambios van al mensaje que Carlos tiene delante, y
 * ese pasa a ser el guardado.
 */
export async function propuestaEnMensajePulsado(callback: TelegramCallbackQuery, propuesta: PropuestaGasto): Promise<PropuestaGasto> {
  const pulsado = callback.message?.message_id;
  const chat = callback.message?.chat.id;
  if (!pulsado || pulsado <= 0 || pulsado === propuesta.messageId || (chat !== undefined && chat !== propuesta.chatId)) return propuesta;
  await actualizarMessageIdGasto(propuesta.id, pulsado).catch((error) =>
    console.error("[gastoCallbackHandler] No se pudo guardar el mensaje pulsado de la propuesta (no crítico):", error instanceof Error ? error.message : error));
  return { ...propuesta, messageId: pulsado };
}

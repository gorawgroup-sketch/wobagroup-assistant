import { deleteTelegramMessage, sendTelegramForceReply, sendTelegramTemporaryNotice } from "../telegram/client";
import {
  consumirPendienteDesambiguacionPorId,
  obtenerPendienteDesambiguacionPorChat,
  registrarRespuestaMessageIdDesambiguacion,
  type PendienteDesambiguacion,
} from "./disambiguationStore";

export const PREFIJO_RESPUESTA_CARPETA = "✏️ Indicar carpeta para ";

const dependencias = {
  listar: obtenerPendienteDesambiguacionPorChat,
  enviar: sendTelegramForceReply,
  registrar: registrarRespuestaMessageIdDesambiguacion,
  consumir: consumirPendienteDesambiguacionPorId,
  // Avisos que se borran solos: informan en el momento sin dejar ruido permanente en el chat.
  avisar: sendTelegramTemporaryNotice as (chatId: number, texto: string) => Promise<unknown>,
  borrar: deleteTelegramMessage,
};

/**
 * Abrir el editor no archiva, consume ni avanza la cola. Devuelve false si la pregunta ya no se puede responder
 * (quien llama retira del chat el mensaje con sus botones).
 */
export async function solicitarRespuestaCarpeta(
  chatId: number,
  id: string,
  deps = dependencias
): Promise<boolean> {
  const pendiente = (await deps.listar(chatId)).find((p) => p.id === id);
  if (!pendiente) {
    await deps.avisar(chatId, "Esta pregunta ya no está disponible (expiró o ya se respondió).");
    return false;
  }
  const messageId = await deps.enviar(chatId,
    `${PREFIJO_RESPUESTA_CARPETA}"${pendiente.nombreArchivoOriginal}"\n\n` +
    `${pendiente.preguntaFormulada}\n\n` +
    "Responde a este mensaje con la empresa y carpeta. Puedes indicar otra carpeta, pedir que cree una nueva o que te muestre las disponibles."
  );
  if (!await deps.registrar(id, chatId, messageId)) {
    // El editor recién abierto ya no sirve: se retira en vez de dejarlo como una pregunta muerta.
    await deps.borrar(chatId, messageId);
    await deps.avisar(chatId, "Este adjunto ya se resolvió con otra acción. No hace falta responder esta pregunta.");
    return false;
  }
  return true;
}

/** Una respuesta explícita tiene prioridad sobre cualquier pendiente genérico del chat. */
export async function resolverRespuestaCarpeta(
  chatId: number,
  replyToMessageId: number | undefined,
  replyToText: string | undefined,
  continuar: (pendiente: PendienteDesambiguacion) => Promise<void>,
  deps = dependencias
): Promise<boolean> {
  if (replyToMessageId === undefined) return false;
  const pendiente = (await deps.listar(chatId)).find((p) =>
    p.messageId === replyToMessageId || p.respuestaMessageIds?.includes(replyToMessageId));
  if (!pendiente) {
    if (!replyToText?.startsWith(PREFIJO_RESPUESTA_CARPETA)) return false;
    // La pregunta a la que se responde ya no sirve: desaparece del chat (el aviso también se borra solo).
    await deps.borrar(chatId, replyToMessageId);
    await deps.avisar(chatId, "Esta pregunta ya no está disponible. Usa «Responder / indicar carpeta» en el adjunto que sigue pendiente.");
    return true;
  }
  const reclamada = await deps.consumir(pendiente.id, chatId);
  if (!reclamada) {
    await deps.avisar(chatId, "Esta pregunta ya está siendo procesada o ya fue resuelta.");
    return true;
  }
  await continuar(reclamada);
  return true;
}

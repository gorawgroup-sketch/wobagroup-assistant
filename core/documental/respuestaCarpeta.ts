import { sendTelegramForceReply, sendTelegramMessage } from "../telegram/client";
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
  avisar: sendTelegramMessage,
};

/** Abrir el editor no archiva, consume ni avanza la cola. */
export async function solicitarRespuestaCarpeta(
  chatId: number,
  id: string,
  deps = dependencias
): Promise<void> {
  const pendiente = (await deps.listar(chatId)).find((p) => p.id === id);
  if (!pendiente) {
    await deps.avisar(chatId, "Esta pregunta ya no está disponible (expiró o ya se respondió).");
    return;
  }
  const messageId = await deps.enviar(chatId,
    `${PREFIJO_RESPUESTA_CARPETA}"${pendiente.nombreArchivoOriginal}"\n\n` +
    `${pendiente.preguntaFormulada}\n\n` +
    "Responde a este mensaje con la empresa y carpeta. Puedes indicar otra carpeta, pedir que cree una nueva o que te muestre las disponibles."
  );
  if (!await deps.registrar(id, chatId, messageId)) {
    await deps.avisar(chatId, "Este adjunto ya se resolvió con otra acción. No hace falta responder esta pregunta.");
  }
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

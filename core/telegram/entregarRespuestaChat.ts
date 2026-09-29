import { obtenerHistorial } from "../claude/conversationStore";
import { MARCA_MENSAJE_SISTEMA, quitarMarcaSistema, respuestaImitaMensajeSistema } from "../claude/respuestaImitaSistema";
import { obtenerActivoActual, contarPendientesTotal } from "../gmail/colaRevisionStore";
import { reenviarPreguntaPendienteDelCorreo } from "../gastos/reenviarPreguntaPendiente";
import { entregarRespuestaTrasTrabajar, sendTelegramMessageWithButtons } from "./client";

/**
 * Entrega la respuesta del chat, salvo que sea una imitación de un aviso automático.
 *
 * Caso real (Carlos, 2026-09-28 20:13): el modelo respondió copiando una propuesta de gasto del
 * historial; llegó con forma de propuesta, sin botones y sin nada registrado detrás. Carlos no podía
 * procesar el gasto y el chat decía que no había nada pendiente. Ver respuestaImitaSistema.ts.
 *
 * Cuando se detecta, nunca se entrega la copia. Se entrega lo que de verdad hay, con botones reales
 * (regla de PR #194 y #240: lo pendiente, al final del chat):
 *  1. la decisión pendiente del correo activo, si existe;
 *  2. si no hay correo activo y quedan correos en cola, el botón para procesar el siguiente;
 *  3. si no hay nada, se dice tal cual.
 */
const dependencias = {
  entregar: entregarRespuestaTrasTrabajar,
  enviarConBotones: sendTelegramMessageWithButtons,
  avisosRecientes: async (chatId: number): Promise<string[]> =>
    (await obtenerHistorial(chatId))
      .filter((m) => m.role === "assistant" && typeof m.content === "string" && m.content.startsWith(MARCA_MENSAJE_SISTEMA))
      .map((m) => m.content as string)
      .slice(-12),
  obtenerActivoActual,
  contarPendientesTotal,
  reenviarPreguntaPendienteDelCorreo,
};

/** Solo para pruebas. */
export function configurarEntregaRespuestaChatParaPruebas(parciales: Partial<typeof dependencias>): () => void {
  const originales = { ...dependencias };
  Object.assign(dependencias, parciales);
  return () => { Object.assign(dependencias, originales); };
}

export async function entregarRespuestaChat(chatId: number, mensajeTrabajandoId: number | undefined, respuestaDelModelo: string): Promise<void> {
  // La marca vive en el historial que lee el modelo; si la copia al empezar su respuesta, nunca llega al usuario.
  const respuesta = quitarMarcaSistema(respuestaDelModelo.trim());
  const avisos = await dependencias.avisosRecientes(chatId).catch(() => [] as string[]);
  const imitacion = respuestaImitaMensajeSistema(respuesta, avisos);
  if (!imitacion.imita) {
    await dependencias.entregar(chatId, mensajeTrabajandoId, respuesta);
    return;
  }
  console.warn(`[chat] La respuesta del modelo imitaba un aviso automático (${imitacion.motivo}); no se entrega. Se muestra lo que hay pendiente de verdad.`);

  const activo = await dependencias.obtenerActivoActual(chatId).catch(() => undefined);
  if (activo) {
    const reenviada = await dependencias.reenviarPreguntaPendienteDelCorreo(
      chatId, activo.mensajeId, activo.id,
      `⏸️ La cola de correo espera tu respuesta al correo "${activo.asunto}" (de ${activo.de}). Aquí tienes de nuevo sus botones:`
    ).catch(() => undefined);
    if (reenviada) {
      await dependencias.entregar(chatId, mensajeTrabajandoId,
        `Lo que está pendiente ahora es «${reenviada.descripcion}». Te he puesto abajo su pregunta con los botones reales.`);
      return;
    }
    await dependencias.entregar(chatId, mensajeTrabajandoId,
      `El correo activo de la cola es "${activo.asunto}" (de ${activo.de}) y no encuentro una pregunta viva para él. ` +
      "Envía /revisarcorreo y te ofreceré reprocesarlo o liberarlo.");
    return;
  }
  const enCola = await dependencias.contarPendientesTotal(chatId).catch(() => 0);
  if (enCola > 0) {
    await dependencias.entregar(chatId, mensajeTrabajandoId,
      `No hay ninguna propuesta esperando tu decisión. Quedan ${enCola} correo(s) en la cola de revisión.`);
    await dependencias.enviarConBotones(chatId, "¿Proceso el siguiente correo de la cola?",
      [[{ text: "▶️ Sí, siguiente", callback_data: "colacorreo_siguiente" }]]);
    return;
  }
  await dependencias.entregar(chatId, mensajeTrabajandoId,
    "No hay ninguna propuesta ni pregunta esperando tu decisión, y la cola de correo está vacía. Dime qué necesitas y lo hago.");
}

import { avanzarColaCorreoSiActivo } from "../jobs/revisarCorreoNuevo";
import { recuperarConciliacionExistenteCompra } from "../holded/write";
import { sendTelegramMessage } from "../telegram/client";
import {
  consumirConciliacionPendiente,
  obtenerTodasLasConciliacionesPendientes,
  restaurarConciliacionPendiente,
} from "./conciliacionPendienteStore";
import type { ConciliacionPendiente } from "./conciliacionPendienteStore";
import { registrarCierreGastoPendiente } from "./gastoCallbackHandler";

/**
 * Preguntas «¿conciliar?» huérfanas.
 *
 * Caso real (Carlos, 2026-09-29): siete gastos de Footprint (Uber, Board Riders, Airalo, LinkedIn…) ya estaban
 * pagados y enlazados a su cargo bancario, con la conciliación verificada en el registro durable, pero su pregunta
 * seguía abierta en el chat. Carlos veía gastos «pendientes de conciliar» que no tenían nada contra qué conciliarse
 * y el correo de cada uno seguía sin cerrar.
 *
 * Esta limpieza hace exactamente lo que haría pulsar «Sí, conciliar» sobre una conciliación ya hecha: relee compra
 * y banco, y solo si esa lectura la confirma cierra el registro del gasto y el correo. Nunca escribe en Holded,
 * nunca busca ni asigna cargos y nunca toca una pregunta cuya conciliación no esté confirmada.
 */
export const EDAD_MINIMA_PREGUNTA_MS = 15 * 60 * 1000;

const depsDefault = {
  listar: obtenerTodasLasConciliacionesPendientes,
  leerConciliacion: recuperarConciliacionExistenteCompra as (empresa: ConciliacionPendiente["empresa"], gastoId: string) => Promise<string>,
  consumir: consumirConciliacionPendiente,
  restaurar: restaurarConciliacionPendiente,
  registrarCierre: registrarCierreGastoPendiente as (pendiente: ConciliacionPendiente) => Promise<void>,
  avanzarCola: avanzarColaCorreoSiActivo as (
    chatId: number, identidad: { threadId?: string; mensajeId?: string }, clave: string
  ) => Promise<boolean>,
  avisar: sendTelegramMessage as (chatId: number, texto: string) => Promise<unknown>,
  ahora: () => Date.now(),
};

export interface ResumenLimpiezaPreguntas {
  revisadas: number;
  cerradas: string[];
  errores: number;
}

export async function cerrarPreguntasConciliacionResueltas(
  deps: typeof depsDefault = depsDefault
): Promise<ResumenLimpiezaPreguntas> {
  const resumen: ResumenLimpiezaPreguntas = { revisadas: 0, cerradas: [], errores: 0 };
  const cerradasPorChat = new Map<number, string[]>();
  for (const candidata of await deps.listar()) {
    // Una pregunta recién enviada puede tener su botón en plena ejecución.
    if (deps.ahora() - candidata.creadoEn < EDAD_MINIMA_PREGUNTA_MS) continue;
    resumen.revisadas++;
    try {
      // Un fallo de lectura no es un dato: la pregunta se queda como está.
      // «pagada_externamente»: la compra ya está pagada entera en Holded fuera de Wobi; tampoco queda nada que decidir.
      const estado = await deps.leerConciliacion(candidata.empresa, candidata.gastoId);
      if (estado !== "conciliada" && estado !== "pagada_externamente") continue;
      const pendiente = await deps.consumir(candidata.id);
      if (!pendiente) continue;
      try {
        if (pendiente.deColaCorreo && pendiente.comprobanteConfirmado && pendiente.mensajeIdGmail) {
          await deps.registrarCierre(pendiente);
          await deps.avanzarCola(
            pendiente.chatId,
            { threadId: pendiente.threadIdGmail, mensajeId: pendiente.mensajeIdGmail },
            `gasto:conciliacion:${pendiente.id}:cierre`
          );
        }
      } catch (error) {
        await deps.restaurar(pendiente);
        throw error;
      }
      resumen.cerradas.push(pendiente.descripcionGasto);
      cerradasPorChat.set(pendiente.chatId, [...(cerradasPorChat.get(pendiente.chatId) ?? []), pendiente.descripcionGasto]);
    } catch (error) {
      resumen.errores++;
      console.error(`[preguntas-huerfanas] No se pudo cerrar la pregunta ${candidata.id} (se conserva):`, error);
    }
  }
  for (const [chatId, descripciones] of cerradasPorChat) {
    await deps.avisar(
      chatId,
      `🧹 Cerré ${descripciones.length} pregunta${descripciones.length === 1 ? "" : "s"} de conciliación que ya estaba` +
        `${descripciones.length === 1 ? "" : "n"} resuelta${descripciones.length === 1 ? "" : "s"} ` +
        `(conciliación confirmada leyendo compra y banco; no creé ningún pago):\n` +
        descripciones.map((d) => `• ${d}`).join("\n") +
        `\n\nSus botones antiguos ya no hacen nada.`
    ).catch((error) => console.error("[preguntas-huerfanas] No se pudo avisar del cierre (no crítico):", error));
  }
  return resumen;
}

import { retirarPreguntaCaducada } from "../telegram/preguntaCaducada";
import { answerCallbackQuery, editTelegramMessage } from "../telegram/client";
import {
  consumirPendienteEdicionCompraHolded,
  eliminarPendienteEdicionCompraHolded,
  obtenerPendienteEdicionCompraHolded,
} from "./pendienteEdicionCompraHoldedStore";
import { editarCompraHolded, EdicionCompraInciertaError, EdicionNoVerificadaError, obtenerCompraHoldedPorId } from "./write";
import { conciliarCargoConReembolso } from "./conciliarCargoConReembolso";
import { estadoRealCompra } from "./automatizacion/tickets";
import { registrarCuentaCorregidaAprendida } from "./cuentaCorregidaAprendidaSheet";
import type { TelegramCallbackQuery } from "../telegram/types";

async function answerCallbackQuerySafe(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    console.error("[edicionCompraHoldedCallbackHandler] No se pudo responder el callback_query (no crítico):", error);
  }
}

/**
 * Botones de una propuesta de edición de compra ya creada en Holded (ver
 * proponerEdicionCompraHoldedTool, core/tools/editarCompraHolded.ts). Solo
 * "edicioncompra_confirmar" dispara el PUT real — "edicioncompra_cancelar"
 * no escribe nada, pero está protegida igual que "gasto_cancelar" (se
 * centraliza en superadmin la decisión completa, no solo la que escribe).
 */
export async function handleEdicionCompraHoldedCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  if (!data) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, id] = data.split(":");
  if (accion !== "edicioncompra_confirmar" && accion !== "edicioncompra_cancelar") {
    await answerCallbackQuerySafe(callback.id, "Acción de edición no reconocida.");
    return;
  }
  const pendiente =
    accion === "edicioncompra_cancelar"
      ? await consumirPendienteEdicionCompraHolded(id)
      : await obtenerPendienteEdicionCompraHolded(id);
  if (!pendiente) {
    await retirarPreguntaCaducada(callback, "Esta propuesta ya no está disponible (expiró o ya se procesó).");
    return;
  }

  if (accion === "edicioncompra_cancelar") {
    await answerCallbackQuerySafe(callback.id, "Cancelado.");
    await editTelegramMessage(pendiente.chatId, pendiente.messageId, `❌ Cancelado — ${pendiente.resumenAntes}`, []);
    return;
  }

  await answerCallbackQuerySafe(callback.id, "Editando...");
  await editTelegramMessage(pendiente.chatId, pendiente.messageId, `🔄 Editando en Holded — ${pendiente.resumenAntes}...`, []);

  try {
    // Propuesta que solo enlaza cargo y reembolso (la edición ya se aplicó antes): no se reenvía el documento.
    const soloConciliar = pendiente.cambios.despuesConciliar !== undefined &&
      Object.entries(pendiente.cambios).every(([campo, valor]) => campo === "despuesConciliar" || valor === undefined);
    const resultado = soloConciliar
      ? await obtenerCompraHoldedPorId(pendiente.empresa, pendiente.purchaseId)
      : await editarCompraHolded(pendiente.empresa, pendiente.purchaseId, pendiente.cambios, {
          idempotencyKey: `propuesta-edicion:${pendiente.id}`,
          proceso: "edicion_compra_aprobada",
        });
    await eliminarPendienteEdicionCompraHolded(pendiente.id).catch((error) =>
      console.error(
        "[edicionCompraHoldedCallbackHandler] La edición quedó verificada, pero no se pudo cerrar la propuesta:",
        error instanceof Error ? error.name : "Error"
      )
    );
    const totalDespues = typeof resultado.total === "number" ? resultado.total.toFixed(2) : String(resultado.total ?? "");
    // Hallazgo real de auditoría: esto mandaba "€" fijo sin importar la
    // moneda real del documento — inofensivo mientras editarCompraHolded
    // reseteaba todo a EUR en silencio (ver ese archivo), pero con ese bug ya
    // corregido, un gasto en USD ahora sí queda en USD en Holded y este
    // mensaje reportaría "€" de todas formas, reproduciendo en el chat la
    // misma confusión ("parece euros, es dólares") que el fix de fondo
    // elimina de Holded.
    const monedaDespues = (resultado.currency ?? "EUR").toUpperCase().trim();
    // Propuesta «cargo + reembolso»: con la edición ya verificada, se enlazan los dos movimientos.
    let notaConciliacion = "";
    if (pendiente.cambios.despuesConciliar) {
      try {
        const enlace = await conciliarCargoConReembolso(pendiente.empresa, pendiente.purchaseId, pendiente.cambios.despuesConciliar);
        notaConciliacion = `\n\n${enlace.completo ? "🔗" : "⚠️"} ${enlace.nota}`;
      } catch (errorEnlace) {
        console.error("[edicionCompraHoldedCallbackHandler] Error enlazando cargo y reembolso:", errorEnlace);
        notaConciliacion = `\n\n⚠️ La edición quedó aplicada, pero no pude enlazar cargo y reembolso: ` +
          `${errorEnlace instanceof Error ? errorEnlace.message : String(errorEnlace)}`;
      }
    }
    // Cambio de cuenta contable (ver proponer_cambio_cuenta_contable_compra): con la edición ya verificada se aprende la
    // corrección para ese proveedor y, si era un ticket, se comprueba que el guardado no lo devolviera a factura de compra.
    let notaCuenta = "";
    const meta = pendiente.cambios.meta;
    if (pendiente.cambios.cuentaIdNueva && meta) {
      try {
        await registrarCuentaCorregidaAprendida(meta.proveedor, pendiente.empresa, pendiente.cambios.cuentaIdNueva, meta.cuentaNombre);
        notaCuenta += `\n\n🧠 Aprendido: los gastos de «${meta.proveedor}» irán a ${meta.cuentaNombre}.`;
      } catch (errorAprendizaje) {
        console.error("[edicionCompraHoldedCallbackHandler] No se pudo guardar el aprendizaje de la cuenta (no crítico):", errorAprendizaje);
        notaCuenta += "\n\n⚠️ El cambio quedó aplicado, pero no pude guardar el aprendizaje de la cuenta.";
      }
      if (meta.eraTicket) {
        const despues = await estadoRealCompra(pendiente.empresa, pendiente.purchaseId).catch(() => undefined);
        notaCuenta += despues?.estado === "ticket"
          ? "\n\n🧾 Sigue siendo ticket."
          : "\n\n⚠️ Era un ticket y ahora Holded lo muestra como factura de compra: hay que desmarcar «Es una factura de compra» de nuevo.";
      }
    }
    await editTelegramMessage(
      pendiente.chatId,
      pendiente.messageId,
      `${soloConciliar ? "🔗 Conciliación" : "✅ Editado en Holded"} — antes: ${pendiente.resumenAntes}\n` +
        `Ahora: ${totalDespues} ${monedaDespues}, doc "${resultado.document_number || "(sin número)"}" (id ${resultado.id} — mismo documento, no se recreó).` +
        notaConciliacion + notaCuenta,
      []
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[edicionCompraHoldedCallbackHandler] Error editando la compra:", message);
    // EdicionNoVerificadaError significa que el PUT SÍ se envió y Holded
    // respondió 200 OK — el documento pudo haber cambiado, solo no de la
    // forma esperada. Nunca decir "no se tocó nada" en ese caso, sería falso.
    const notaEstado =
      error instanceof EdicionNoVerificadaError || error instanceof EdicionCompraInciertaError
        ? "La edición pudo haberse enviado a Holded. Wobi bloqueó cualquier repetición automática; revísala allí y conserva esta propuesta hasta que la reconciliación confirme el resultado."
        : "El documento original no se tocó, revísalo a mano si hace falta.";
    await editTelegramMessage(
      pendiente.chatId,
      pendiente.messageId,
      `⚠️ No pude confirmar la edición de "${pendiente.resumenAntes}" en Holded: ${message}\n\n${notaEstado}`,
      []
    );
  }
}

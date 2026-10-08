import { obtenerBotonesActivos } from "../../cerebro/webBotonesStore";
import { deleteTelegramMessage, sendTelegramMessageWithButtons } from "../../telegram/client";
import { almacenCambiosReal, textoDePropuesta, type CambioPendiente, type DatosActualizarPoliza, type DatosRecordar, type DatosRetirar } from "./cambiosPendientes";

/**
 * Vuelve a poner AL FINAL del chat una propuesta de Wobi Seguros que sigue esperando «Aplicar / Cancelar» (caso real de
 * Carlos, 2026-10-08: la propuesta existía y estaba vigente, pero quedó enterrada). Mismo id, mismos botones: la fila se
 * apunta al mensaje nuevo y el viejo se borra para que no haya dos con los mismos botones. No aplica ni cancela nada.
 */
export async function reenviarPropuestaSeguros(cambio: CambioPendiente): Promise<number> {
  const mensajes = await obtenerBotonesActivos(cambio.chatId).catch((e) => { console.error("[reenviarPropuestaSeguros] No se pudo leer el espejo de botones:", e instanceof Error ? e.message : e); return []; });
  const original = mensajes.find((m) => m.messageId === cambio.messageId)?.texto;
  const texto = original ?? textoDePropuesta(cambio.accion, JSON.parse(cambio.datos) as DatosActualizarPoliza | DatosRecordar | DatosRetirar, cambio.cita);
  const nuevoId = await sendTelegramMessageWithButtons(cambio.chatId, texto, [[
    { text: "✅ Aplicar", callback_data: `segcambio_aplicar:${cambio.id}` },
    { text: "❌ Cancelar", callback_data: `segcambio_cancelar:${cambio.id}` },
  ]]);
  await almacenCambiosReal.actualizarMessageId(cambio.id, nuevoId);
  if (cambio.messageId > 0) await deleteTelegramMessage(cambio.chatId, cambio.messageId).catch((e) => console.error("[reenviarPropuestaSeguros] No se pudo borrar el mensaje viejo (no crítico):", e instanceof Error ? e.message : e));
  return nuevoId;
}

import { sendTelegramMessageWithButtons } from "../telegram/client";
import { botonesSalidaPendiente, describirFaltaPendiente } from "./gastoPendienteDatosActions";
import type { GastoPendienteDatos } from "./gastoPendienteDatosStore";

/** El mensaje de una pendiente de datos que se vuelve a poner al final del chat (sin buscar nada: es barato y no toca Holded). */
export function textoPendienteReenviada(p: GastoPendienteDatos): string {
  const d = p.datos;
  return (
    `📄 ${d.empresaProbable ?? "Empresa sin confirmar"} · ${d.proveedor || "Proveedor sin nombre"} · ${d.monto} ${d.moneda} · ${d.fecha || "sin fecha"}.\n` +
    `Este documento ya se leyó y está esperando ${describirFaltaPendiente(p.motivo)}.` +
    (p.motivo === "moneda" ? `\nPulsa «Buscar el cargo otra vez» cuando el banco ya lo muestre: si hay varios cargos posibles, te los ofrezco con botón.` : "")
  );
}

/**
 * Vuelve a mostrar una pendiente de datos con sus botones de salida. Lo usa `/preguntas`: así un documento que quedó atascado (incluso de antes
 * de un despliegue, cuando su mensaje original no tenía botones) se retoma con un comando. Nunca crea, concilia ni descarta nada por sí solo.
 */
export async function reenviarPendienteDatos(p: GastoPendienteDatos): Promise<void> {
  await sendTelegramMessageWithButtons(p.chatId, textoPendienteReenviada(p), botonesSalidaPendiente(p.id, p.motivo, p.deColaCorreo === true));
}

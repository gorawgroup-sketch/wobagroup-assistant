import { actualizarMessageIdGasto, type PropuestaGasto } from "./gastoProposalSheet";
import { construirTecladoGasto, opcionesTecladoDesdePropuesta } from "./gastoTeclado";
import { sendTelegramMessageWithButtons } from "../telegram/client";

/**
 * Bug real encontrado en vivo (2026-09-07, y confirmado que ya había pasado antes el 2026-09-02 con
 * otra factura — "JESUS GOMEZ TARRIÑO", 3448.28€): crearPropuestaGasto (gastoProposalSheet.ts) guarda
 * la propuesta en Sheets con messageId=0 ANTES de mandar el mensaje real de Telegram — si algo
 * interrumpe el proceso entre esos dos pasos (una caída transitoria de la API de Telegram, un
 * redeploy justo en ese momento, cualquier excepción no capturada en el tramo intermedio que arma el
 * texto/botones), la propuesta queda huérfana: existe completa en Sheets, pero Carlos nunca vio
 * ningún mensaje con botones — "para ti ya pasó, pero el chat no lo muestra", como lo describió él
 * mismo. Peor todavía: buscarPropuestaGastoPendiente (el chequeo de "no mandes una segunda propuesta
 * para el mismo documento") encuentra esta propuesta huérfana igual que una real, y le dice a Carlos
 * "revisa esa antes" — señalando un mensaje que jamás existió, dejándolo sin ninguna vía real para
 * resolverlo salvo pedir ayuda manual.
 *
 * Esta función cierra el hueco: reenvía los botones reales de una propuesta ya completa (nueva o
 * huérfana) como mensaje NUEVO al final del chat, y repunta la propuesta a ese mensaje. La reutilizan
 * tanto procesarGastoEntrante.ts (cuando detecta que la propuesta "ya pendiente" nunca se entregó,
 * messageId=0) como reenviarBotonesPropuestaGasto.ts (tool conversacional para cuando el usuario pide
 * confirmar en texto libre una propuesta cuyos botones quedaron fuera de vista).
 */
export async function reenviarPropuestaGasto(propuesta: PropuestaGasto, encabezado: string): Promise<number> {
  const teclado = construirTecladoGasto(propuesta, opcionesTecladoDesdePropuesta(propuesta));
  const texto =
    `${encabezado}\n\n` +
    `${propuesta.proveedor} — ${propuesta.monto.toFixed(2)} ${propuesta.moneda} (${propuesta.fecha}, ${propuesta.empresa})\n` +
    `Concepto: ${propuesta.concepto}`;

  const messageId = await sendTelegramMessageWithButtons(propuesta.chatId, texto, teclado);
  await actualizarMessageIdGasto(propuesta.id, messageId).catch((error) =>
    console.error("[reenviarPropuestaGasto] Error actualizando el messageId (no crítico — el mensaje ya se mandó):", error)
  );
  return messageId;
}

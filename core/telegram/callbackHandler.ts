import { answerCallbackQuery, editTelegramMessage } from "./client";
import { consumirPropuesta } from "../google/proposalSheet";
import { cashflowEscrituraTool } from "../tools/cashflowEscritura";
import type { TelegramCallbackQuery } from "./types";

/**
 * Responder el callback_query es solo para quitar el ícono de "cargando" del
 * botón — nunca debe bloquear la lógica real (aprobar/ignorar/escribir). Si
 * Telegram lo rechaza (ID viejo/expirado, timeout), lo registramos y seguimos.
 */
async function answerCallbackQuerySafe(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[callbackHandler] No se pudo responder el callback_query (no crítico):", message);
  }
}

/**
 * Único punto del código que puede disparar la escritura en el cashflow:
 * se ejecuta exclusivamente en reacción a que el usuario presione el botón
 * "✅ Agregar" sobre una propuesta concreta generada por
 * revisarHoldedVsCashflow. Nunca se invoca desde el flujo de conversación
 * normal (askClaude) ni desde el job de detección directamente.
 */
export async function handleCallbackQuery(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  if (!data) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, id, bloqueElegido] = data.split(":");

  if (accion !== "cf_approve" && accion !== "cf_reject") {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const propuesta = await consumirPropuesta(id);

  if (!propuesta) {
    await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible (expiró o ya fue procesada).");
    return;
  }

  if (accion === "cf_reject") {
    await answerCallbackQuerySafe(callback.id, "Ignorado.");
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `❌ Ignorado — ${propuesta.clienteOConcepto} (${propuesta.semana}, ${propuesta.valor.toFixed(2)} €)`,
      []
    );
    return;
  }

  // accion === "cf_approve"
  await answerCallbackQuerySafe(callback.id, "Registrando...");

  try {
    // El callback_data lleva la categoría que el usuario eligió por botón
    // (cf_approve:<id>:<bloque>) — es la fuente de verdad sobre cuál usar,
    // no el bloqueSugerido guardado (que es solo el top-1 al momento de
    // proponer). Se cae a bloqueSugerido solo por compatibilidad con
    // propuestas ya creadas antes de este cambio.
    const bloque = (bloqueElegido || propuesta.bloqueSugerido) as typeof propuesta.bloqueSugerido;

    const resultado = await cashflowEscrituraTool.handler({
      empresa: propuesta.empresa,
      bloque,
      cliente_o_concepto: propuesta.clienteOConcepto,
      semana: propuesta.semana,
      valor: propuesta.valor,
    });

    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `✅ Agregado — ${propuesta.clienteOConcepto} (${propuesta.semana}, ${propuesta.valor.toFixed(2)} €)\n\n${resultado}`,
      []
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[callbackHandler] Error registrando movimiento:", message);

    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `⚠️ Error al registrar — ${propuesta.clienteOConcepto} (${propuesta.semana}, ${propuesta.valor.toFixed(2)} €)\n\n${message}`,
      []
    );
  }
}

import { answerCallbackQuery, editTelegramMessage } from "./client";
import { consumirPropuesta, obtenerPropuesta } from "../google/proposalSheet";
import { AREAS_PROPUESTA_CASHFLOW, botonesAreasCashflow } from "../google/cashflowProposalButtons";
import { cashflowEscrituraTool } from "../tools/cashflowEscritura";
import { registrarDuplicadoConfirmado } from "../cashflow/duplicadosConfirmadosSheet";
import { buscarDuplicadoCashflowActual } from "../jobs/revisarHoldedVsCashflow";
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
const dependenciasCallbackCashflow = { obtenerPropuesta, consumirPropuesta, editTelegramMessage, answerCallbackQuerySafe };

export async function handleCallbackQuery(
  callback: TelegramCallbackQuery,
  dependencias = dependenciasCallbackCashflow
): Promise<void> {
  const { obtenerPropuesta, consumirPropuesta, editTelegramMessage, answerCallbackQuerySafe } = dependencias;
  const data = callback.data;
  if (!data) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, id, bloqueElegido] = data.split(":");

  if (accion !== "cf_approve" && accion !== "cf_reject" && accion !== "cf_duplicado" && accion !== "cf_area") {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const visible = await obtenerPropuesta(id);
  if (visible && callback.message?.chat.id !== visible.chatId) {
    await answerCallbackQuerySafe(callback.id, "Esta propuesta pertenece a otro chat.");
    return;
  }
  if (accion === "cf_area") {
    await answerCallbackQuerySafe(callback.id, visible ? "Elige el área." : "Propuesta no disponible.");
    if (visible) await editTelegramMessage(visible.chatId, visible.messageId,
      `${visible.empresa} · ${visible.semana} · ${visible.clienteOConcepto} · ${visible.valor.toFixed(2)} €\n\n` +
      (visible.montoDuplicado !== undefined ? `Posible duplicado de ${visible.montoDuplicado.toFixed(2)} € ya registrado. Elige «Es duplicado» si es el mismo pago.\n\n` : "") +
      "Elige dónde registrarlo. Las secciones de pendientes son saldos pendientes, no gastos pagados. " +
      "«No registrar» descarta únicamente esta propuesta; no borra nada del banco ni de Holded.",
      [...botonesAreasCashflow(visible.id), ...(visible.montoDuplicado !== undefined
        ? [[{ text: "🔁 Es duplicado", callback_data: `cf_duplicado:${visible.id}` }]] : [])]);
    return;
  }
  if (accion === "cf_approve" && bloqueElegido && !AREAS_PROPUESTA_CASHFLOW.some(a => a.bloque === bloqueElegido)) {
    await answerCallbackQuerySafe(callback.id, "Área no disponible; elige otra opción.");
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
      `No registrado en cash flow — ${propuesta.clienteOConcepto} (${propuesta.semana}, ${propuesta.valor.toFixed(2)} €). El banco y Holded no se modificaron.`,
      []
    );
    return;
  }

  // El botón "🔁 Es duplicado" solo aparece cuando revisarHoldedVsCashflow
  // detectó una fila parecida ya registrada (guarda su monto en
  // propuesta.montoDuplicado) — el usuario confirma que es el MISMO pago,
  // así que no se crea nada nuevo (igual que "❌ Ignorar"), pero además se
  // aprende el patrón de variación de monto de este proveedor en
  // duplicadosConfirmadosSheet.ts para reconocerlo con más contexto la
  // próxima vez. Pedido explícito: esto nunca hace que el sistema deje de
  // preguntar en el futuro, solo reduce la duda con la que pregunta.
  if (accion === "cf_duplicado") {
    if (propuesta.montoDuplicado === undefined) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta no tiene un duplicado asociado.");
      return;
    }

    await answerCallbackQuerySafe(callback.id, "Anotado.");

    try {
      await registrarDuplicadoConfirmado(
        propuesta.clienteOConcepto,
        propuesta.empresa,
        propuesta.valor,
        propuesta.montoDuplicado
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[callbackHandler] Error guardando duplicado confirmado (no crítico):", message);
    }

    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `🔁 Duplicado confirmado — ${propuesta.clienteOConcepto} (${propuesta.semana}, ${propuesta.valor.toFixed(2)} € vs ${propuesta.montoDuplicado.toFixed(2)} € ya registrado). ` +
        `No se crea nada nuevo. Anotado para reconocer este patrón con más contexto la próxima vez.`,
      []
    );
    return;
  }

  // accion === "cf_approve"
  await answerCallbackQuerySafe(callback.id, "Registrando...");

  try {
    // Si la propuesta nació sin advertencia de duplicado, se relee el cashflow antes de escribir.
    // Puede haberse registrado una fila mientras el botón esperaba, o tratarse de una categoría sin
    // columna EMPRESA que la detección antigua no veía. Ante cualquier duda se bloquea la escritura.
    if (propuesta.montoDuplicado === undefined) {
      const duplicadoActual = await buscarDuplicadoCashflowActual(
        propuesta.empresa,
        propuesta.semana,
        propuesta.clienteOConcepto,
        propuesta.valor
      );
      if (duplicadoActual) {
        await editTelegramMessage(
          propuesta.chatId,
          propuesta.messageId,
          `⛔ No se agregó — al releer el cashflow encontré una fila posiblemente duplicada: "${duplicadoActual.descripcionRegistro}". ` +
            `Genera una revisión nueva para decidir explícitamente si es el mismo pago o un cargo distinto.`,
          []
        );
        return;
      }
    }

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
      `Resultado del registro — ${propuesta.clienteOConcepto} (${propuesta.semana}, ${propuesta.valor.toFixed(2)} €)\n\n${resultado}`,
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

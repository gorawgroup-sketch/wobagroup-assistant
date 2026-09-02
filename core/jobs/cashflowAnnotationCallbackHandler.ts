import { answerCallbackQuery, editTelegramMessage, sendTelegramMessage } from "../telegram/client";
import { consumirPropuestaAccionAnotacion } from "./cashflowAnnotationActionStore";
import { guardarPendienteOrientacionAnotacion } from "./cashflowAnnotationOrientationStore";
import { askClaude } from "../claude/client";
import type { TelegramCallbackQuery } from "../telegram/types";

async function answerCallbackQuerySafe(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cashflowAnnotationCallbackHandler] No se pudo responder el callback_query (no crítico):", message);
  }
}

/**
 * Maneja los botones de una propuesta de acción sobre una anotación del
 * cashflow (anotcf_proceder / anotcf_orientar / anotcf_descartar) — mismo
 * patrón que handleEmailActionCallback en emailCallbackHandler.ts.
 *
 * "Hazlo tú" NUNCA ejecuta nada por fuera del registro normal de
 * herramientas de askClaude — las mismas que ya usa el chat, con las mismas
 * reglas de "proponer y esperar aprobación" para cualquier escritura real
 * (Holded, cashflow, correo). Esto solo le da a Claude la vía libre para
 * INVESTIGAR y proponer/ejecutar lo que ya podría hacer si Carlos se lo
 * pidiera por chat — no le da ningún poder nuevo.
 */
export async function handleCashflowAnnotationActionCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  if (!data) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, id] = data.split(":");
  const propuesta = await consumirPropuestaAccionAnotacion(id);

  if (!propuesta) {
    await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible (expiró o ya fue procesada).");
    return;
  }

  if (accion === "anotcf_descartar") {
    await answerCallbackQuerySafe(callback.id, "Ok.");
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `ℹ️ Dejado como informativo — ${propuesta.ubicacion}`,
      []
    );
    return;
  }

  if (accion === "anotcf_orientar") {
    await answerCallbackQuerySafe(callback.id);
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `✏️ Ok — respóndeme qué quieres que haga con esto (${propuesta.ubicacion}).`,
      []
    );
    await guardarPendienteOrientacionAnotacion({
      chatId: propuesta.chatId,
      messageId: propuesta.messageId,
      ubicacion: propuesta.ubicacion,
      detalle: propuesta.detalle,
      recomendacion: propuesta.recomendacion,
    });
    return;
  }

  // anotcf_proceder
  await answerCallbackQuerySafe(callback.id, "Procesando...");
  await editTelegramMessage(
    propuesta.chatId,
    propuesta.messageId,
    `🔄 Procesando — ${propuesta.ubicacion}\n\nEsto puede tardar uno o dos minutos si hace falta explorar Holded o el cashflow.`,
    []
  ).catch((error) => console.error("[cashflowAnnotationCallbackHandler] No se pudo mostrar 'Procesando...' (no crítico):", error));

  try {
    const instruccion =
      `Se aprobó proceder con esta anotación del cashflow (comentario real de Google Sheets). ` +
      `Ubicación: ${propuesta.ubicacion}. Detalle: ${propuesta.detalle}. ` +
      `Recomendación previa que ya diste: ${propuesta.recomendacion}. ` +
      `Investiga y ejecuta lo que corresponda con las herramientas disponibles (Holded, cashflow, correo si hace ` +
      `falta), y reporta el resultado.`;

    const respuesta = await askClaude(instruccion, propuesta.chatId);

    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `✅ Procesado — ${propuesta.ubicacion}\n\n${respuesta}`,
      []
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cashflowAnnotationCallbackHandler] Error procediendo con la acción:", message);
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `⚠️ Error al procesar — ${propuesta.ubicacion}\n\n${message}`,
      []
    );
  }
}

/**
 * Continúa el flujo cuando el usuario responde con instrucciones específicas
 * (después de pulsar "✏️ Dar instrucciones"). Mismo camino seguro que
 * "Hazlo tú": pasa por askClaude con su registro de tools ya existente,
 * nunca ejecuta nada fuera de eso.
 */
export async function continuarConOrientacionAnotacion(
  chatId: number,
  ubicacion: string,
  detalle: string,
  recomendacion: string,
  instruccionUsuario: string
): Promise<void> {
  await sendTelegramMessage(chatId, "🔄 Procesando tu instrucción — esto puede tardar uno o dos minutos...").catch(
    (error) => console.error("[cashflowAnnotationCallbackHandler] No se pudo mostrar 'Procesando...' (no crítico):", error)
  );

  const instruccion =
    `El usuario dio instrucciones específicas sobre esta anotación del cashflow. ` +
    `Ubicación: ${ubicacion}. Detalle: ${detalle}. Recomendación previa que ya diste: ${recomendacion}. ` +
    `Instrucción del usuario: ${instruccionUsuario}. ` +
    `Investiga y ejecuta lo que corresponda con las herramientas disponibles, y reporta el resultado.`;

  const respuesta = await askClaude(instruccion, chatId);
  await sendTelegramMessage(chatId, respuesta);
}

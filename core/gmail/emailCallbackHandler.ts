import { answerCallbackQuery, editTelegramMessage, sendTelegramMessage } from "../telegram/client";
import { consumirPropuestaAccionCorreo } from "./emailActionStore";
import { guardarPendienteOrientacionCorreo } from "./emailOrientationStore";
import { askClaude } from "../claude/client";
import type { TelegramCallbackQuery } from "../telegram/types";

async function answerCallbackQuerySafe(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[emailCallbackHandler] No se pudo responder el callback_query (no crítico):", message);
  }
}

/**
 * Maneja los botones de una propuesta de acción sobre un correo
 * (email_proceder / email_descartar / email_orientar).
 *
 * "Proceder" NUNCA ejecuta el texto del correo directamente — dispara al
 * asistente normal (askClaude, con su registro de tools ya existente, todas
 * de solo lectura o ya protegidas con su propio botón de aprobación) para
 * que investigue y reporte. Los tools de escritura real (cashflow, subida a
 * Drive) no están en ese registro, así que este camino nunca puede
 * disparar una escritura por sí solo.
 */
export async function handleEmailActionCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  if (!data) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, id] = data.split(":");
  const propuesta = await consumirPropuestaAccionCorreo(id);

  if (!propuesta) {
    await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible (expiró o ya fue procesada).");
    return;
  }

  if (accion === "email_descartar") {
    await answerCallbackQuerySafe(callback.id, "Descartado.");
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `❌ Descartado — ${propuesta.asunto} (${propuesta.de})`,
      []
    );
    return;
  }

  if (accion === "email_orientar") {
    await answerCallbackQuerySafe(callback.id);
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `✏️ Ok — respóndeme qué quieres que haga con este correo ("${propuesta.asunto}", de ${propuesta.de}).`,
      []
    );
    await guardarPendienteOrientacionCorreo({
      chatId: propuesta.chatId,
      messageId: propuesta.messageId,
      de: propuesta.de,
      asunto: propuesta.asunto,
      resumen: propuesta.resumen,
    });
    return;
  }

  // email_proceder
  await answerCallbackQuerySafe(callback.id, "Procesando...");

  try {
    const instruccion =
      `Se aprobó proceder con esta acción propuesta a partir de un correo entrante. ` +
      `Correo — De: ${propuesta.de}. Asunto: ${propuesta.asunto}. Resumen: ${propuesta.resumen}. ` +
      `Acción a realizar: ${propuesta.accionSugerida}. ` +
      `Investiga y ejecuta lo que corresponda con las herramientas disponibles, y reporta el resultado.`;

    const respuesta = await askClaude(instruccion);

    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `✅ Procesado — ${propuesta.asunto} (${propuesta.de})\n\n${respuesta}`,
      []
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[emailCallbackHandler] Error procediendo con la acción:", message);
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `⚠️ Error al procesar — ${propuesta.asunto} (${propuesta.de})\n\n${message}`,
      []
    );
  }
}

/**
 * Continúa el flujo cuando el usuario responde con orientación específica
 * (después de pulsar "✏️ Dar instrucciones específicas"). Mismo camino
 * seguro que "Proceder": pasa por askClaude con su registro de tools ya
 * existente, nunca ejecuta nada fuera de eso.
 */
export async function continuarConOrientacion(
  chatId: number,
  de: string,
  asunto: string,
  resumen: string,
  instruccionUsuario: string
): Promise<void> {
  const instruccion =
    `El usuario dio instrucciones específicas sobre un correo entrante. ` +
    `Correo — De: ${de}. Asunto: ${asunto}. Resumen: ${resumen}. ` +
    `Instrucción del usuario: ${instruccionUsuario}. ` +
    `Investiga y ejecuta lo que corresponda con las herramientas disponibles, y reporta el resultado.`;

  const respuesta = await askClaude(instruccion);
  await sendTelegramMessage(chatId, respuesta);
}

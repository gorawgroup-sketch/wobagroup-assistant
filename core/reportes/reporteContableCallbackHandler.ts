import { answerCallbackQuery, editTelegramMessage } from "../telegram/client";
import { consultarEnvioCorreoExistente, enviarCorreo } from "../gmail/client";
import { EnvioCorreoInciertoError } from "../gmail/durableSend";
import { generarReporteContable } from "../holded/accounting";
import { generarExcelContable, generarPDFContable } from "./generarReporteContable";
import { consumirPropuestaReporteContable, obtenerPropuestaReporteContable } from "./reporteContableProposalStore";
import type { TelegramCallbackQuery } from "../telegram/types";

async function answerCallbackQuerySafe(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[reporteContableCallbackHandler] No se pudo responder el callback_query (no crítico):", message);
  }
}

/**
 * Maneja los botones de la propuesta de envío de reporte contable por
 * correo (reportecontable_enviar / reportecontable_cancelar). El Excel/PDF
 * se regenera en el momento de aprobar — nunca se guarda el binario en el
 * store de la propuesta, solo los parámetros (empresa, fechas, destino).
 */
export async function handleReporteContableCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  if (!data) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, id] = data.split(":");
  const propuesta = await obtenerPropuestaReporteContable(id);

  if (!propuesta) {
    await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible (expiró o ya fue procesada).");
    return;
  }

  if (accion === "reportecontable_cancelar") {
    await answerCallbackQuerySafe(callback.id);
    await consumirPropuestaReporteContable(id);
    await editTelegramMessage(propuesta.chatId, propuesta.messageId, "❌ Envío del reporte cancelado.", []);
    return;
  }

  // reportecontable_enviar
  await answerCallbackQuerySafe(callback.id, "Generando y enviando...");

  try {
    const idempotencyKey = `reporte-contable:${propuesta.id}`;
    const envioExistente = await consultarEnvioCorreoExistente(idempotencyKey);
    if (envioExistente) {
      await consumirPropuestaReporteContable(id);
      await editTelegramMessage(
        propuesta.chatId,
        propuesta.messageId,
        `✅ El reporte de ${propuesta.empresa} ya estaba confirmado en Gmail; no se generó ni envió una segunda copia.`,
        []
      );
      return;
    }
    const reporte = await generarReporteContable(propuesta.empresa, propuesta.desde, propuesta.hasta);
    const [excel, pdf] = await Promise.all([generarExcelContable(reporte), generarPDFContable(reporte)]);

    await enviarCorreo({
      to: propuesta.correoDestino,
      asunto: `Balance y P&L de ${propuesta.empresa} — ${propuesta.desde} a ${propuesta.hasta}`,
      cuerpo:
        `Adjunto el balance y pérdidas y ganancias de ${propuesta.empresa} para el período ${propuesta.desde} a ${propuesta.hasta}.\n\n` +
        `Reconstruido a partir de los datos contables reales de Holded (no es la exportación oficial de Holded, esa función no está disponible por su API) — resultado aproximado del período: ${reporte.resultadoAproximado.toFixed(2)} EUR.\n\n` +
        `— Wobi`,
      idempotencyKey,
      proceso: "reporte_contable",
      adjuntos: [
        { filename: excel.filename, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: excel.buffer },
        { filename: pdf.filename, mimeType: "application/pdf", content: pdf.buffer },
      ],
    });

    await consumirPropuestaReporteContable(id);

    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `✅ Reporte de ${propuesta.empresa} (${propuesta.desde} a ${propuesta.hasta}) enviado por correo a ${propuesta.correoDestino}.`,
      []
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error generando/enviando reporte contable:", message);
    const incierto = error instanceof EnvioCorreoInciertoError;
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      incierto
        ? "⚠️ Gmail no confirmó si el reporte salió. Wobi bloqueó el reenvío para evitar duplicarlo y verificará el resultado contra la carpeta Enviados."
        : `⚠️ No se pudo generar o enviar el reporte (error: ${message}). La propuesta se conserva y puedes reintentar.`,
      incierto
        ? []
        : [[{ text: "📤 Reintentar", callback_data: `rpt_retry:${id}:${Date.now().toString(36)}` }]]
    );
  }
}

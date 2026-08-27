import { answerCallbackQuery, editTelegramMessage } from "../telegram/client";
import { enviarCorreo } from "../gmail/client";
import { generarReporteContable } from "../holded/accounting";
import { generarExcelContable, generarPDFContable } from "./generarReporteContable";
import { consumirPropuestaReporteContable } from "./reporteContableProposalStore";
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
  const propuesta = await consumirPropuestaReporteContable(id);

  if (!propuesta) {
    await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible (expiró o ya fue procesada).");
    return;
  }

  if (accion === "reportecontable_cancelar") {
    await answerCallbackQuerySafe(callback.id);
    await editTelegramMessage(propuesta.chatId, propuesta.messageId, "❌ Envío del reporte cancelado.", []);
    return;
  }

  // reportecontable_enviar
  await answerCallbackQuerySafe(callback.id, "Generando y enviando...");

  try {
    const reporte = await generarReporteContable(propuesta.empresa, propuesta.desde, propuesta.hasta);
    const [excel, pdf] = await Promise.all([generarExcelContable(reporte), generarPDFContable(reporte)]);

    await enviarCorreo({
      to: propuesta.correoDestino,
      asunto: `Balance y P&L de ${propuesta.empresa} — ${propuesta.desde} a ${propuesta.hasta}`,
      cuerpo:
        `Adjunto el balance y pérdidas y ganancias de ${propuesta.empresa} para el período ${propuesta.desde} a ${propuesta.hasta}.\n\n` +
        `Reconstruido a partir de los datos contables reales de Holded (no es la exportación oficial de Holded, esa función no está disponible por su API) — resultado aproximado del período: ${reporte.resultadoAproximado.toFixed(2)} EUR.\n\n` +
        `— Wobi`,
      adjuntos: [
        { filename: excel.filename, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: excel.buffer },
        { filename: pdf.filename, mimeType: "application/pdf", content: pdf.buffer },
      ],
    });

    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `✅ Reporte de ${propuesta.empresa} (${propuesta.desde} a ${propuesta.hasta}) enviado por correo a ${propuesta.correoDestino}.`,
      []
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error generando/enviando reporte contable:", message);
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `⚠️ No se pudo generar o enviar el reporte (error: ${message}). Nada se envió — puedes pedirlo de nuevo.`,
      []
    );
  }
}

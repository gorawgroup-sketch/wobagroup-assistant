import { answerCallbackQuery, editTelegramMessage } from "../telegram/client";
import { consumirPropuestaEvento } from "./eventoProposalSheet";
import { crearEventoHolded } from "../holded/write";
import type { TelegramCallbackQuery } from "../telegram/types";

async function answerCallbackQuerySafe(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    console.error("[eventoCallbackHandler] No se pudo responder el callback_query (no crítico):", error);
  }
}

/**
 * Maneja los botones de propuestas de evento de calendario (evento_confirmar /
 * evento_cancelar). Solo evento_confirmar escribe algo real en Holded — nunca
 * ocurre automáticamente, solo tras presionar el botón (y solo un admin puede
 * presionarlo, ver esAccionSensible en authorizedUsersSheet.ts).
 */
export async function handleEventoCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  if (!data) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, propuestaId] = data.split(":");
  const propuesta = await consumirPropuestaEvento(propuestaId);

  if (!propuesta) {
    await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
    return;
  }

  if (accion === "evento_cancelar") {
    await answerCallbackQuerySafe(callback.id, "Cancelado.");
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `❌ Cancelado — ${propuesta.nombre} (${propuesta.empresa})`,
      []
    );
    return;
  }

  if (accion !== "evento_confirmar") {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  await answerCallbackQuerySafe(callback.id, "Programando...");
  await editTelegramMessage(propuesta.chatId, propuesta.messageId, `🔄 Programando "${propuesta.nombre}"...`, []);

  try {
    const evento = await crearEventoHolded(propuesta.empresa, {
      nombre: propuesta.nombre,
      tipo: propuesta.tipo,
      descripcion: propuesta.descripcion,
      fechaInicio: propuesta.fechaInicio,
      fechaFin: propuesta.fechaFin,
      contactId: propuesta.contactId,
      ubicacion: propuesta.ubicacion,
    });

    const [fecha, horaInicio] = propuesta.fechaInicio.split("T");
    const horaFin = propuesta.fechaFin.split("T")[1]?.slice(0, 5) ?? "";

    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `✅ Actividad programada en el calendario de ${propuesta.empresa} (id ${evento.id})\n` +
        `${propuesta.nombre} — ${fecha}, ${horaInicio.slice(0, 5)}–${horaFin}`,
      []
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[eventoCallbackHandler] Error creando evento en Holded:", message);
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `⚠️ Error programando "${propuesta.nombre}"\n\n${message}`,
      []
    );
  }
}

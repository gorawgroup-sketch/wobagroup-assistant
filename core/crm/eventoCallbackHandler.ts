import { answerCallbackQuery, editTelegramMessage } from "../telegram/client";
import { consumirPropuestaEvento } from "./eventoProposalSheet";
import { crearEventoHolded, buscarUsuarioHoldedPorNombre } from "../holded/write";
import type { TelegramCallbackQuery } from "../telegram/types";

// Todas las escrituras de eventos están gateadas a superadmin (esAccionSensible
// en authorizedUsersSheet.ts), y hoy el único superadmin es Carlos — por eso
// se usa directo su correo real de Holded (confirmado en vivo vía /employees:
// "Carlos Gonzalez", carlos@wobagroup.com) como dueño/participante de todo
// evento que se programe. Si algún día hay más de un superadmin, esto debería
// resolverse dinámicamente por quién aprobó el botón, no quedar fijo aquí.
const NOMBRE_PROGRAMADOR = "Carlos Gonzalez";
const EMAIL_PROGRAMADOR = "carlos@wobagroup.com";

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
    const userId = await buscarUsuarioHoldedPorNombre(propuesta.empresa, NOMBRE_PROGRAMADOR);

    const evento = await crearEventoHolded(propuesta.empresa, {
      nombre: propuesta.nombre,
      tipo: propuesta.tipo,
      descripcion: propuesta.descripcion,
      fechaInicio: propuesta.fechaInicio,
      fechaFin: propuesta.fechaFin,
      contactId: propuesta.contactId,
      ubicacion: propuesta.ubicacion,
      userId,
      participantes: [{ email: EMAIL_PROGRAMADOR, name: NOMBRE_PROGRAMADOR }],
    });

    const [fecha, horaInicio] = propuesta.fechaInicio.split("T");
    const horaFin = propuesta.fechaFin.split("T")[1]?.slice(0, 5) ?? "";

    const notaVerificacion = evento.verificado
      ? ""
      : `\n\n⚠️ No pude releer el evento después de crearlo para confirmar que quedó accesible — revísalo a mano en Holded.`;
    const notaDueno = userId
      ? ""
      : `\n\n⚠️ No encontré a "${NOMBRE_PROGRAMADOR}" como usuario de Holded en ${propuesta.empresa} — el evento quedó sin dueño asignado, podría no aparecer en tu vista de calendario filtrada.`;

    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `✅ Creado en Holded y confirmado que el id existe (${propuesta.empresa}, id ${evento.id})\n` +
        `${propuesta.nombre} — ${fecha}, ${horaInicio.slice(0, 5)}–${horaFin}\n` +
        `Le puse dueño (${NOMBRE_PROGRAMADOR}) y participante (${EMAIL_PROGRAMADOR}) para que Holded mande la ` +
        `notificación — la API de Holded no me deja releer esos dos campos para confirmar que se guardaron, así ` +
        `que la primera vez avísame si de verdad aparece en tu vista del calendario y si te llegó el correo.` +
        notaVerificacion +
        notaDueno,
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

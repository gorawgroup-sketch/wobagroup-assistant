import { posponerCorreoActivoYContinuar } from "../gmail/posponerCorreoActivo";
import { unlink } from "node:fs/promises";
import {
  answerCallbackQuery,
  editTelegramMessage,
  editTelegramMessageReplyMarkup,
  sendTelegramMessage,
} from "../telegram/client";
import type { TelegramCallbackQuery } from "../telegram/types";
import { avanzarColaCorreoSiActivo } from "../jobs/revisarCorreoNuevo";
import {
  consumirGastoPendienteDatosPorId,
  obtenerGastosPendienteDatosPorChat,
  restaurarGastoPendienteDatos,
} from "./gastoPendienteDatosStore";
import { procesarGastoEntrante } from "./procesarGastoEntrante";

async function responderCallback(id: string, texto?: string): Promise<void> {
  await answerCallbackQuery(id, texto).catch((error) =>
    console.error("[gastoPendienteDatosCallback] No se pudo responder el callback (no crítico):", error)
  );
}

/**
 * Resuelve los dos botones de una verificacion estricta de duplicados:
 * reintentar la misma factura, o confirmar que el analisis es correcto y
 * cerrar solo esa unidad de trabajo. El id del pendiente y el chat deben
 * coincidir; nunca se consume "el ultimo" ni se busca por proveedor/monto.
 */
export async function handleGastoPendienteDatosCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data ?? "";
  const [accion, pendienteId] = data.split(":");
  const chatId = callback.message?.chat.id;
  const messageId = callback.message?.message_id;

  if (chatId === undefined || !pendienteId ||
      (accion !== "gpd_reintentar" && accion !== "gpd_confirmar" && accion !== "gpd_posponer")) {
    await responderCallback(callback.id, "Esta acción no es válida.");
    return;
  }

  if (accion === "gpd_posponer") {
    const pendiente = (await obtenerGastosPendienteDatosPorChat(chatId)).find(p => p.id === pendienteId);
    if (!pendiente || pendiente.motivo !== "verificacion_duplicado" || !pendiente.deColaCorreo ||
        !pendiente.correoOrigen?.threadId || !pendiente.correoOrigen?.mensajeIdGmail) {
      await responderCallback(callback.id, "No hay un correo exacto pendiente para este botón.");
      return;
    }
    await responderCallback(callback.id, "Dejando pendiente y continuando...");
    const resultado = await posponerCorreoActivoYContinuar(chatId, {
      threadId: pendiente.correoOrigen.threadId, mensajeId: pendiente.correoOrigen.mensajeIdGmail,
    });
    if (!resultado.startsWith("Correo aplazado")) await sendTelegramMessage(chatId, resultado).catch(() => {});
    return;
  }

  const pendiente = await consumirGastoPendienteDatosPorId(chatId, pendienteId);
  if (!pendiente) {
    await responderCallback(callback.id, "Esta pendiente ya fue procesada o reemplazada.");
    if (messageId !== undefined) {
      await editTelegramMessageReplyMarkup(chatId, messageId, []).catch(() => {});
    }
    return;
  }

  if (pendiente.motivo !== "verificacion_duplicado") {
    await restaurarGastoPendienteDatos(pendiente);
    await responderCallback(callback.id, "Este botón no corresponde a esta pendiente.");
    return;
  }

  await responderCallback(
    callback.id,
    accion === "gpd_reintentar" ? "Reprocesando..." : "Confirmando y continuando..."
  );
  if (messageId !== undefined) {
    await editTelegramMessageReplyMarkup(chatId, messageId, []).catch((error) =>
      console.error("[gastoPendienteDatosCallback] No se pudo desactivar el teclado (no crítico):", error)
    );
  }

  if (accion === "gpd_confirmar") {
    try {
      if (pendiente.deColaCorreo) {
        await avanzarColaCorreoSiActivo(
          chatId,
          {
            threadId: pendiente.correoOrigen?.threadId,
            mensajeId: pendiente.correoOrigen?.mensajeIdGmail,
          },
          `gasto-pendiente-datos:${pendiente.id}:confirmar-duplicado`,
          { continuarAutomaticamente: true }
        );
      }
    } catch (error) {
      await restaurarGastoPendienteDatos(pendiente).catch(() => {});
      const detalle = error instanceof Error ? error.message : String(error);
      await sendTelegramMessage(
        chatId,
        `⚠️ No pude cerrar esta pendiente (${detalle}). La conservé intacta para reintentar; no se modificó Holded.`
      ).catch(() => {});
      return;
    }

    // La decision durable ya termino. Un fallo cosmetico al editar el
    // mensaje nunca debe restaurarla y volver a bloquear el correo.
    await unlink(pendiente.rutaLocal).catch(() => {});
    const texto =
      `✅ Análisis confirmado — ${pendiente.datos.proveedor} ` +
      `(${pendiente.datos.monto} ${pendiente.datos.moneda}). No se creó ni modificó ningún gasto en Holded.`;
    if (messageId !== undefined) {
      await editTelegramMessage(chatId, messageId, texto, [])
        .catch(() => sendTelegramMessage(chatId, texto).catch(() => {}));
    } else {
      await sendTelegramMessage(chatId, texto).catch(() => {});
    }
    return;
  }

  try {
    const resultado = await procesarGastoEntrante({
      chatId,
      rutaLocal: pendiente.rutaLocal,
      nombreArchivoOriginal: pendiente.nombreArchivoOriginal,
      mimeType: pendiente.mimeType,
      datos: pendiente.datos,
      deColaCorreo: pendiente.deColaCorreo,
      correoOrigen: pendiente.correoOrigen,
      origenAdjuntoGmail: pendiente.origenAdjuntoGmail,
    });

    if (resultado === "propuesta_duplicada" && pendiente.deColaCorreo) {
      await avanzarColaCorreoSiActivo(
        chatId,
        {
          threadId: pendiente.correoOrigen?.threadId,
          mensajeId: pendiente.correoOrigen?.mensajeIdGmail,
        },
        `gasto-pendiente-datos:${pendiente.id}:reprocesar`
      );
    }

    const textoResultado =
      resultado === "pendiente_datos"
        ? "🔄 Pendiente reprocesada. La verificación actualizada y sus botones aparecen en el mensaje nuevo."
        : resultado === "propuesta_duplicada"
          ? "✅ Reprocesado: Holded confirmó evidencia suficiente de duplicado. No se creó otro gasto."
          : resultado === "propuesta_pendiente_existente"
            ? "🔎 Reprocesado: ya existe una propuesta pendiente para esta factura; no se generó otra."
            : "✅ Reprocesado: se generó una propuesta nueva con sus acciones seguras.";

    if (messageId !== undefined) {
      await editTelegramMessage(chatId, messageId, textoResultado, []).catch(() => {});
    }
  } catch (error) {
    await restaurarGastoPendienteDatos(pendiente).catch(() => {});
    const detalle = error instanceof Error ? error.message : String(error);
    await sendTelegramMessage(
      chatId,
      `⚠️ No pude reprocesar esta pendiente (${detalle}). Quedó conservada exactamente como estaba y no se modificó Holded.`
    ).catch(() => {});
  }
}

import { posponerCorreoActivoYContinuar } from "../gmail/posponerCorreoActivo";
import { unlink } from "node:fs/promises";
import {
  answerCallbackQuery,
  editTelegramMessage,
  editTelegramMessageReplyMarkup,
  sendTelegramMessage,
} from "../telegram/client";
import { retirarPreguntaCaducada } from "../telegram/preguntaCaducada";
import type { TelegramCallbackQuery } from "../telegram/types";
import { avanzarColaCorreoSiActivo } from "../jobs/revisarCorreoNuevo";
import {
  consumirGastoPendienteDatosPorId,
  obtenerGastosPendienteDatosPorChat,
  restaurarGastoPendienteDatos,
} from "./gastoPendienteDatosStore";
import { parsearCargoElegido, parsearEmpresaElegida } from "./gastoPendienteDatosActions";
import { procesarGastoEntrante } from "./procesarGastoEntrante";

async function responderCallback(id: string, texto?: string): Promise<void> {
  await answerCallbackQuery(id, texto).catch((error) =>
    console.error("[gastoPendienteDatosCallback] No se pudo responder el callback (no crítico):", error)
  );
}

/** Pendientes de un documento ya leído: el cargo del banco, la empresa, la fecha, el proveedor o la verificación de duplicados. */
const MOTIVOS_CON_BOTONES = new Set(["verificacion_duplicado", "moneda", "empresa", "fecha", "proveedor"]);

/**
 * Resuelve los botones de una pendiente de datos:
 *  - verificación estricta de duplicados: reintentar, confirmar el análisis o dejarla pendiente y seguir;
 *  - documento que espera el cargo del banco («moneda»): buscar el cargo otra vez, elegir uno de los cargos
 *    ofrecidos (`gpd_cargo`, que reanuda con el importe y la moneda REALES de ese cargo, igual que escribirlos a mano)
 *    o dejarla pendiente y seguir.
 * El id del pendiente y el chat deben coincidir; nunca se consume "el ultimo" ni se busca por proveedor/monto.
 */
export async function handleGastoPendienteDatosCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data ?? "";
  const [accion, pendienteIdCrudo] = data.split(":");
  const cargoElegido = accion === "gpd_cargo" ? parsearCargoElegido(data) : null;
  const empresaElegida = accion === "gpd_empresa" ? parsearEmpresaElegida(data) : null;
  const pendienteId = accion === "gpd_cargo" ? cargoElegido?.id : accion === "gpd_empresa" ? empresaElegida?.id : pendienteIdCrudo;
  const chatId = callback.message?.chat.id;
  const messageId = callback.message?.message_id;

  if (chatId === undefined || !pendienteId ||
      (accion !== "gpd_reintentar" && accion !== "gpd_confirmar" && accion !== "gpd_posponer" && accion !== "gpd_cargo" &&
        accion !== "gpd_empresa" && accion !== "gpd_descartar") ||
      (accion === "gpd_cargo" && !cargoElegido) || (accion === "gpd_empresa" && !empresaElegida)) {
    await responderCallback(callback.id, "Esta acción no es válida.");
    return;
  }

  if (accion === "gpd_posponer") {
    const pendiente = (await obtenerGastosPendienteDatosPorChat(chatId)).find(p => p.id === pendienteId);
    if (!pendiente || !MOTIVOS_CON_BOTONES.has(pendiente.motivo) || !pendiente.deColaCorreo ||
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
    // Igual que el resto de preguntas caducadas: desaparece del chat en vez de quedar clickeable sin efecto.
    await retirarPreguntaCaducada(callback, "Esta pendiente ya fue procesada o reemplazada.");
    return;
  }

  // «Confirmar el análisis» solo existe para duplicados; el resto de botones también valen para un documento a la espera del banco.
  const motivoValido = accion === "gpd_confirmar" ? pendiente.motivo === "verificacion_duplicado" : MOTIVOS_CON_BOTONES.has(pendiente.motivo);
  // Elegir un cargo solo tiene sentido cuando lo que falta es el cargo real («moneda»).
  if (!motivoValido || (accion === "gpd_cargo" && pendiente.motivo !== "moneda") || (accion === "gpd_empresa" && pendiente.motivo !== "empresa")) {
    await restaurarGastoPendienteDatos(pendiente);
    await responderCallback(callback.id, "Este botón no corresponde a esta pendiente.");
    return;
  }

  await responderCallback(
    callback.id,
    accion === "gpd_confirmar" ? "Confirmando y continuando..."
      : accion === "gpd_cargo" ? "Usando ese cargo..."
        : accion === "gpd_empresa" ? `Usando ${empresaElegida?.empresa}...`
          : accion === "gpd_descartar" ? "Descartando..."
            : pendiente.motivo === "moneda" ? "Buscando el cargo otra vez..." : "Reprocesando..."
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

  if (accion === "gpd_descartar") {
    try {
      if (pendiente.deColaCorreo) {
        await avanzarColaCorreoSiActivo(
          chatId,
          { threadId: pendiente.correoOrigen?.threadId, mensajeId: pendiente.correoOrigen?.mensajeIdGmail },
          `gasto-pendiente-datos:${pendiente.id}:descartar`
        );
      }
    } catch (error) {
      await restaurarGastoPendienteDatos(pendiente).catch(() => {});
      const detalle = error instanceof Error ? error.message : String(error);
      await sendTelegramMessage(chatId, `⚠️ No pude descartar esta pendiente (${detalle}). La conservé intacta; no se modificó Holded.`).catch(() => {});
      return;
    }
    await unlink(pendiente.rutaLocal).catch(() => {});
    const texto = `🗑️ Descartado — ${pendiente.datos.proveedor} (${pendiente.datos.monto} ${pendiente.datos.moneda}). No se creó ni se propuso ningún gasto en Holded.`;
    if (messageId !== undefined) {
      await editTelegramMessage(chatId, messageId, texto, []).catch(() => sendTelegramMessage(chatId, texto).catch(() => {}));
    } else {
      await sendTelegramMessage(chatId, texto).catch(() => {});
    }
    return;
  }

  // Con un cargo o una empresa elegidos, el documento se reanuda con ese dato: lo mismo que escribirlo a mano.
  const datosParaReanudar = cargoElegido
    ? { ...pendiente.datos, montoEquivalente: cargoElegido.monto, monedaEquivalente: cargoElegido.moneda }
    : empresaElegida
      ? { ...pendiente.datos, empresaProbable: empresaElegida.empresa }
      : pendiente.datos;

  try {
    const resultado = await procesarGastoEntrante({
      chatId,
      rutaLocal: pendiente.rutaLocal,
      nombreArchivoOriginal: pendiente.nombreArchivoOriginal,
      mimeType: pendiente.mimeType,
      datos: datosParaReanudar,
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
        ? pendiente.motivo === "moneda"
          ? "🔄 Sigue pendiente: el mensaje nuevo dice qué falta y trae sus botones."
          : "🔄 Pendiente reprocesada. La verificación actualizada y sus botones aparecen en el mensaje nuevo."
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

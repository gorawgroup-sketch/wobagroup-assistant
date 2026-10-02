import { retirarPreguntaCaducada } from "../telegram/preguntaCaducada";
import { answerCallbackQuery, editTelegramMessage } from "../telegram/client";
import { crearPendienteRegistroManualCashflow, consumirPendienteRegistroManualCashflow } from "./pendienteRegistroManualCashflowStore";
import { registrarMovimientoEnSheet, registrarPendienteEnSheet, BLOQUES_SECCION_COMPARTIDA, type BloqueEscritura } from "./cashflowWrite";
import { aplicarDestinoRegistroManual, botonesRegistroManualCashflow, esAreaValidaRegistroManual } from "./registroManualCashflowDestino";
import type { TelegramCallbackQuery } from "../telegram/types";
import { enviarCorreo } from "../gmail/client";
import { registrarDocumentoArchivadoDesdeCorreo } from "../documental/documentoArchivadoPorCorreoStore";
import { avanzarColaCorreoSiActivo } from "../jobs/revisarCorreoNuevo";
import type { PendienteRegistroManualCashflow } from "./pendienteRegistroManualCashflowStore";

/**
 * La propuesta nació de un adjunto de correo (factura de venta): al resolverse —registrada o cancelada— ese adjunto
 * queda resuelto, para que un reproceso del correo no lo vuelva a proponer y la cola de revisión avance.
 */
async function cerrarAdjuntoDeCorreo(pendiente: PendienteRegistroManualCashflow): Promise<void> {
  const correo = pendiente.correo;
  if (!correo?.mensajeIdGmail) return;
  try {
    if (correo.partId) await registrarDocumentoArchivadoDesdeCorreo({ mensajeIdGmail: correo.mensajeIdGmail, attachmentId: correo.partId });
    if (correo.deColaCorreo) {
      await avanzarColaCorreoSiActivo(
        pendiente.chatId,
        { threadId: correo.threadId, mensajeId: correo.mensajeIdGmail },
        `regmanualcf:${pendiente.id}:resolver`
      );
    }
  } catch (error) {
    console.error("[registroManualCashflowCallbackHandler] No se pudo cerrar el adjunto del correo:", error instanceof Error ? error.message : error);
  }
}

/**
 * El registro falló y la propuesta ya se consumió. Si venía de un correo, se vuelve a publicar con botones nuevos:
 * sin esto el adjunto quedaba sin resolver y sin ningún botón para reintentarlo.
 */
async function avisarFalloRegistro(pendiente: PendienteRegistroManualCashflow, motivo: string): Promise<void> {
  if (!pendiente.correo) {
    await editTelegramMessage(pendiente.chatId, pendiente.messageId, `⚠️ No pude confirmar el registro de "${pendiente.resumen}" en el cashflow: ${motivo}\n\nRevísalo a mano si hace falta.`, []);
    return;
  }
  const { id: _id, creadoEn: _creadoEn, ...datos } = pendiente;
  const nueva = await crearPendienteRegistroManualCashflow(datos);
  await editTelegramMessage(
    pendiente.chatId,
    pendiente.messageId,
    `⚠️ No pude confirmar el registro de "${pendiente.resumen}" en el cashflow: ${motivo}\n\nNo respondí el correo. Puedes reintentarlo con estos botones.`,
    [
      [{ text: "✅ Registrar en Ingresos y responder al remitente", callback_data: `regmanualcf_confirmar:${nueva.id}:${nueva.bloque}:responder` }],
      ...botonesRegistroManualCashflow(nueva.id, nueva.bloque, Boolean(nueva.semana)),
    ]
  );
}

/** Responde en el mismo hilo a quien envió la factura. Devuelve la frase que se añade al mensaje final. */
async function responderAlRemitente(pendiente: PendienteRegistroManualCashflow): Promise<string> {
  const correo = pendiente.correo;
  if (!correo) return "";
  try {
    await enviarCorreo({
      to: correo.de,
      asunto: /^re:/i.test(correo.asunto) ? correo.asunto : `Re: ${correo.asunto}`,
      cuerpo: correo.textoRespuesta,
      idempotencyKey: `regmanualcf:${pendiente.id}:respuesta`,
      proceso: "borrador_aprobado",
      threadId: correo.threadId,
      messageIdHeader: correo.messageIdHeader,
    });
    return `\n✉️ Respondí a ${correo.de} que la factura ya está leída y su importe en el cashflow.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[registroManualCashflowCallbackHandler] El registro quedó hecho, pero falló la respuesta al remitente:", message);
    return `\n⚠️ El registro quedó hecho, pero no pude enviar la respuesta a ${correo.de} (${message}). Pídeme que le responda.`;
  }
}

async function answerCallbackQuerySafe(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    console.error("[registroManualCashflowCallbackHandler] No se pudo responder el callback_query (no crítico):", error);
  }
}

/**
 * Botones de una propuesta de registro manual nuevo en cashflow ya creada (ver
 * proponerRegistroManualCashflowTool, core/tools/registrarManualCashflow.ts). Solo
 * "regmanualcf_confirmar" dispara la escritura real — "regmanualcf_cancelar" no escribe nada, pero está
 * protegida igual (mismo criterio que edicioncashflow_cancelar: se centraliza en superadmin la decisión
 * completa, no solo la que escribe).
 */
export async function handleRegistroManualCashflowCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  if (!data) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, id, areaElegida, extra] = data.split(":");
  const responder = extra === "responder";
  const original = await consumirPendienteRegistroManualCashflow(id);
  if (!original) {
    await retirarPreguntaCaducada(callback, "Esta propuesta ya no está disponible (expiró o ya se procesó).");
    return;
  }
  // Botón «↪️ Mejor en <área>»: mismo registro, otra área de destino.
  const cambiaArea = accion === "regmanualcf_confirmar" && areaElegida !== undefined;
  if (cambiaArea && !esAreaValidaRegistroManual(areaElegida, Boolean(original.semana))) {
    await answerCallbackQuerySafe(callback.id, "Esa área no admite este registro.");
    await editTelegramMessage(original.chatId, original.messageId,
      `⚠️ No registré nada: el área "${areaElegida}" no admite este registro — ${original.resumen}. Pídemelo de nuevo indicando el área.`, []);
    return;
  }
  const pendiente = cambiaArea ? aplicarDestinoRegistroManual(original, areaElegida as BloqueEscritura) : original;

  if (accion === "regmanualcf_cancelar") {
    await answerCallbackQuerySafe(callback.id, "Cancelado.");
    await editTelegramMessage(pendiente.chatId, pendiente.messageId, `❌ Cancelado — ${pendiente.resumen}`, []);
    await cerrarAdjuntoDeCorreo(pendiente);
    return;
  }

  await answerCallbackQuerySafe(callback.id, "Registrando...");
  await editTelegramMessage(pendiente.chatId, pendiente.messageId, `🔄 Registrando en cashflow — ${pendiente.resumen}...`, []);

  try {
    const esSeccionCompartida = (BLOQUES_SECCION_COMPARTIDA as string[]).includes(pendiente.bloque);

    const resultado = esSeccionCompartida
      ? await registrarPendienteEnSheet({
          seccion: pendiente.bloque as "pagos_pendientes_alberto" | "deudas_pendientes",
          empresa: pendiente.empresa,
          cliente: pendiente.clienteOConcepto,
          semana: pendiente.semana,
          valor: pendiente.valor,
        })
      : await registrarMovimientoEnSheet({
          bloque: pendiente.bloque,
          cliente_o_concepto: pendiente.clienteOConcepto,
          proyecto: pendiente.proyecto,
          banco: pendiente.banco,
          semana: pendiente.semana ?? "",
          valor: pendiente.valor,
          empresa: pendiente.empresa,
        });

    if (!resultado.ok) {
      await avisarFalloRegistro(pendiente, resultado.mensaje);
      return;
    }

    // El correo solo se responde después de que la fila quedó escrita y verificada.
    const notaRespuesta = responder ? await responderAlRemitente(pendiente) : "";
    await editTelegramMessage(pendiente.chatId, pendiente.messageId, `✅ Registrado en cashflow — ${pendiente.resumen} (${resultado.rango}).${notaRespuesta}`, []);
    await cerrarAdjuntoDeCorreo(pendiente);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[registroManualCashflowCallbackHandler] Error registrando en el cashflow:", message);
    await avisarFalloRegistro(pendiente, message);
  }
}

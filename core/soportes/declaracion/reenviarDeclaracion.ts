import { buscarMensajes, obtenerResumenCorreo } from "../../gmail/client";
import { actualizarMessageIdBorrador, consumirBorradorCorreo, crearBorradorCorreo, obtenerBorradorCorreo } from "../../gmail/emailDraftStore";
import type { Empresa } from "../../holded/client";
import { editTelegramMessage, sendTelegramMessageWithButtons } from "../../telegram/client";
import { listarDeclaraciones, obtenerDeclaracion, type Declaracion } from "./declaracionStore";
import { textoCorreoDeclaracion } from "./generarDeclaracion";
import { fechaCorta, importe } from "./plantillaDeclaracion";

const MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Reenvío de una declaración de gastos sin soporte ya generada, en el mismo hilo del correo anterior.
 * Caso que lo originó (12-10-2026): el correo a German salió sin el documento porque el almacén de borradores
 * no persistía las columnas del adjunto. Carlos pidió un correo nuevo con disculpa, el documento adjunto y las
 * instrucciones claras de qué hacer. Es genérico: cualquier declaración «generada» o «enviada», de cualquier
 * persona y empresa, y también sirve para volver a mandarla cuando la persona dice que no la recibió.
 * El envío real sigue siendo solo con el botón «Enviar así».
 */
export type MotivoReenvio = "sin_adjunto" | "no_recibida";

export interface EntradaReenvio {
  chatId: number;
  /** Id de la declaración; si falta, se busca la última no cerrada de la persona en la empresa. */
  declaracionId?: string;
  empresa?: Empresa;
  email?: string;
  motivo: MotivoReenvio;
}

export interface ResultadoReenvio { declaracion: Declaracion; borradorId: string; messageId: number; enElHilo: boolean }

export function textoCorreoReenvioDeclaracion(d: { titular: string; empresa: Empresa; cargos: Declaracion["cargos"]; nombreArchivo: string; motivo: MotivoReenvio }): { asunto: string; cuerpo: string } {
  const nombre = d.titular.trim().split(/\s+/)[0] || d.titular;
  const total = d.cargos.reduce((s, c) => s + c.valor, 0);
  const lineas = d.cargos.map((c) => `• ${fechaCorta(c.fecha)} · ${c.lugar} · ${importe(c.valor)}`).join("\n");
  const { asunto } = textoCorreoDeclaracion({ titular: d.titular, empresa: d.empresa as Empresa, cargos: d.cargos });
  const disculpa = d.motivo === "sin_adjunto"
    ? "Te pedimos disculpas: en el correo anterior olvidamos adjuntar la declaración. Aquí va."
    : "Te volvemos a enviar la declaración por si el correo anterior no te llegó.";
  return {
    asunto,
    cuerpo: [
      `Hola ${nombre},`,
      "",
      disculpa,
      "",
      `Adjunto encontrarás el documento «${d.nombreArchivo}» con la relación de los cargos de tu tarjeta de los que no conservas comprobante:`,
      lineas,
      `Total: ${importe(total)}`,
      "",
      "Qué tienes que hacer:",
      "1. Descarga el documento adjunto y revisa que los datos sean correctos.",
      "2. Fírmalo: puedes imprimirlo y firmarlo a mano, o firmarlo digitalmente en tu ordenador o móvil.",
      "3. Respóndenos a este mismo correo con el documento firmado (vale una foto nítida o un PDF).",
      "",
      "Con el documento firmado esos gastos quedan justificados en contabilidad y no te pediremos nada más sobre ellos. Si algún dato no cuadra, dínoslo respondiendo a este correo.",
      "",
      "Gracias y perdona las molestias.",
    ].join("\n"),
  };
}

/** Localiza el correo ya enviado a la persona con el asunto de la declaración para responder en su mismo hilo. */
export async function localizarHiloEnviado(d: Declaracion): Promise<{ threadId: string; messageIdHeader: string } | undefined> {
  const { asunto } = textoCorreoDeclaracion({ titular: d.titular, empresa: d.empresa as Empresa, cargos: d.cargos });
  const ids = await buscarMensajes(`in:sent to:${d.email} subject:"${asunto}"`, 3);
  for (const id of ids) {
    const resumen = await obtenerResumenCorreo(id);
    if (d.threadId && resumen.threadId !== d.threadId) continue;
    if (resumen.threadId && resumen.messageIdHeader) return { threadId: resumen.threadId, messageIdHeader: resumen.messageIdHeader };
  }
  return undefined;
}

export async function elegirDeclaracionAReenviar(e: Pick<EntradaReenvio, "declaracionId" | "empresa" | "email">): Promise<Declaracion> {
  if (e.declaracionId) {
    const d = await obtenerDeclaracion(e.declaracionId);
    if (!d) throw new Error(`No existe la declaración ${e.declaracionId}.`);
    return d;
  }
  if (!e.email) throw new Error("Hace falta el id de la declaración o el correo de la persona.");
  const candidatas = (await listarDeclaraciones({ empresa: e.empresa, email: e.email, estados: ["generada", "enviada"] }))
    .sort((a, b) => b.creadoEn - a.creadoEn);
  if (!candidatas.length) throw new Error(`${e.email} no tiene ninguna declaración pendiente de firma${e.empresa ? ` en ${e.empresa}` : ""}.`);
  return candidatas[0];
}

export async function reenviarDeclaracion(e: EntradaReenvio): Promise<ResultadoReenvio> {
  const declaracion = await elegirDeclaracionAReenviar(e);
  if (declaracion.estado === "firmada" || declaracion.estado === "aplicada") {
    throw new Error(`La declaración de ${declaracion.titular} ya está ${declaracion.estado}; no hay nada que reenviar.`);
  }
  const hilo = await localizarHiloEnviado(declaracion);
  const { asunto, cuerpo } = textoCorreoReenvioDeclaracion({ titular: declaracion.titular, empresa: declaracion.empresa as Empresa, cargos: declaracion.cargos, nombreArchivo: declaracion.nombreArchivo, motivo: e.motivo });
  const borrador = await crearBorradorCorreo({
    chatId: e.chatId, messageId: 0, to: declaracion.email, subject: asunto, cuerpo, threadId: hilo?.threadId, messageIdHeader: hilo?.messageIdHeader,
    adjuntosDrive: [{ fileId: declaracion.driveFileId, nombre: declaracion.nombreArchivo, mimeType: MIME_DOCX }], declaracionId: declaracion.id,
  });
  const texto = [
    `✉️ Reenvío de la declaración de gastos sin soporte de ${declaracion.titular} (${declaracion.empresa}) a ${declaracion.email}, ${hilo ? "como respuesta en el hilo del correo anterior" : "en un correo nuevo (no encontré el correo anterior en Enviados)"}, con el documento adjunto: ${declaracion.nombreArchivo}`,
    `Asunto: ${asunto}`, "", cuerpo,
  ].join("\n");
  let messageId = 0;
  try {
    messageId = await sendTelegramMessageWithButtons(e.chatId, texto, [
      [{ text: "📤 Enviar así", callback_data: `draft_enviar:${borrador.id}` }, { text: "✏️ Editar antes de enviar", callback_data: `draft_editar:${borrador.id}` }],
      [{ text: "❌ No enviar", callback_data: `draft_cancelar:${borrador.id}` }],
    ]);
    await actualizarMessageIdBorrador(borrador.id, messageId);
    const confirmado = await obtenerBorradorCorreo(borrador.id);
    if (!confirmado || confirmado.messageId !== messageId) throw new Error("El borrador se mostró, pero su entrega no quedó confirmada en el estado durable.");
    if (!confirmado.adjuntosDrive?.length || confirmado.declaracionId !== declaracion.id) {
      throw new Error("El borrador quedó guardado sin el adjunto o sin la declaración: no se ofrece el envío para no repetir un correo sin documento.");
    }
  } catch (error) {
    await consumirBorradorCorreo(borrador.id).catch(() => undefined);
    if (messageId > 0) {
      await editTelegramMessage(e.chatId, messageId, "⚠️ Este borrador no quedó guardado de forma segura (faltaba el adjunto o la declaración) y sus botones fueron desactivados. Vuelve a pedir el reenvío.", []).catch(() => undefined);
    }
    throw error;
  }
  return { declaracion, borradorId: borrador.id, messageId, enElHilo: Boolean(hilo) };
}

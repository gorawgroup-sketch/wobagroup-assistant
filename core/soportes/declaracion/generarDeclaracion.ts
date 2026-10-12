import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { descargarArchivoDrive, resolverOCrearCarpeta, subirArchivoADrive } from "../../drive/client";
import { ROOT_FOLDERS } from "../../drive/rootFolders";
import { actualizarMessageIdBorrador, consumirBorradorCorreo, crearBorradorCorreo, obtenerBorradorCorreo } from "../../gmail/emailDraftStore";
import type { Empresa } from "../../holded/client";
import { editTelegramMessage, sendTelegramMessageWithButtons } from "../../telegram/client";
import { ultimaSolicitudEnviada } from "../campanaSoportesStore";
import { actualizarDeclaracion, crearDeclaracion, type CargoDeclarado, type Declaracion } from "./declaracionStore";
import { fechaCorta, importe, rellenarPlantillaDeclaracion } from "./plantillaDeclaracion";
import { FIRMA_EMPRESA, plantillaDeclaracionDe, RUTA_CARPETA_DECLARACIONES } from "./plantillas";

const UPLOADS_DIR = join(process.cwd(), "tmp", "uploads");
const MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Paso A del flujo «declaración de gastos sin soporte» (Carlos, 12-10-2026): a partir de los cargos pedidos a una persona
 * que no tiene comprobante, rellena la plantilla de su empresa, la guarda en Drive, deja registro durable y propone a
 * Carlos el correo a esa persona con el documento adjunto (botón «Enviar así» del borrador: nada sale sin aprobación).
 * Pasos B (seguimiento hasta recibir la firma) y C (aplicarla como soporte en Holded) se construyen aparte sobre el
 * mismo registro.
 */
export interface EntradaDeclaracion {
  chatId: number;
  empresa: Empresa;
  titular: string;
  email: string;
  cargoFirmante: string;
  /** Cargos explícitos (p. ej. los que la persona dice no tener); si faltan, se toman los de la última solicitud enviada. */
  cargos?: CargoDeclarado[];
  /** Hilo del correo de la persona al que responder (si el documento se manda como respuesta). */
  threadId?: string;
  messageIdHeader?: string;
}

export interface ResultadoDeclaracion { declaracion: Declaracion; borradorId: string; messageId: number }

export async function cargosDeLaUltimaSolicitud(empresa: Empresa, email: string): Promise<CargoDeclarado[]> {
  const campana = await ultimaSolicitudEnviada(email, empresa);
  if (!campana) return [];
  return campana.cargos.map((c) => ({ id: c.id, fecha: c.fecha, lugar: c.comercio, valor: c.total, moneda: c.monedaCuenta }));
}

export function textoCorreoDeclaracion(d: { titular: string; empresa: Empresa; cargos: CargoDeclarado[] }): { asunto: string; cuerpo: string } {
  const nombre = d.titular.trim().split(/\s+/)[0] || d.titular;
  const total = d.cargos.reduce((s, c) => s + c.valor, 0);
  const lineas = d.cargos.map((c) => `• ${fechaCorta(c.fecha)} · ${c.lugar} · ${importe(c.valor)}`).join("\n");
  return {
    asunto: `${d.empresa} · Declaración de gastos sin soporte para tu firma`,
    cuerpo: [
      `Hola ${nombre},`,
      "",
      `Como nos indicaste que no conservas los comprobantes de estos cargos de tu tarjeta, te adjuntamos la declaración de gastos sin soporte de ${FIRMA_EMPRESA[d.empresa] ?? d.empresa} con su relación:`,
      lineas,
      `Total: ${importe(total)}`,
      "",
      "Por favor, fírmala y devuélvenosla respondiendo a este mismo correo (vale una foto o un PDF del documento firmado). Con ese documento firmado quedan justificados en contabilidad.",
      "",
      "Gracias.",
    ].join("\n"),
  };
}

export async function generarYProponerDeclaracion(e: EntradaDeclaracion): Promise<ResultadoDeclaracion> {
  const plantillaId = plantillaDeclaracionDe(e.empresa);
  if (!plantillaId) throw new Error(`${e.empresa} no tiene plantilla de declaración de gastos sin soporte configurada.`);
  const cargos = e.cargos?.length ? e.cargos : await cargosDeLaUltimaSolicitud(e.empresa, e.email);
  if (!cargos.length) throw new Error(`No hay cargos sin soporte registrados para ${e.titular} (${e.email}) en ${e.empresa}: ni explícitos ni en la última solicitud enviada.`);

  const plantilla = await descargarArchivoDrive(plantillaId);
  const docx = await rellenarPlantillaDeclaracion(plantilla.bytes, {
    nombre: e.titular, cargo: e.cargoFirmante, lineas: cargos.map((c) => ({ fecha: c.fecha, lugar: c.lugar, valor: c.valor })),
  });

  const hoy = new Date().toISOString().slice(0, 10);
  const nombreArchivo = `GASTOS SIN SOPORTE ${e.titular.toUpperCase()} ${hoy}.docx`;
  await mkdir(UPLOADS_DIR, { recursive: true });
  const rutaLocal = join(UPLOADS_DIR, `${Date.now()}_declaracion_${e.empresa}.docx`);
  await writeFile(rutaLocal, docx);
  let subido: { fileId: string; webViewLink: string };
  try {
    const carpeta = await resolverOCrearCarpeta(ROOT_FOLDERS[e.empresa], RUTA_CARPETA_DECLARACIONES);
    subido = await subirArchivoADrive(rutaLocal, nombreArchivo, MIME_DOCX, carpeta.folderId, `declaracion:${e.empresa}:${e.email}:${hoy}:${cargos.map((c) => c.id).join(",")}`, "declaracion_sin_soporte");
  } finally {
    await unlink(rutaLocal).catch(() => undefined);
  }

  const declaracion = await crearDeclaracion({ empresa: e.empresa, titular: e.titular, email: e.email, cargoFirmante: e.cargoFirmante, chatId: e.chatId,
    cargos, driveFileId: subido.fileId, driveUrl: subido.webViewLink, nombreArchivo });

  const { asunto, cuerpo } = textoCorreoDeclaracion({ titular: e.titular, empresa: e.empresa, cargos });
  const borrador = await crearBorradorCorreo({
    chatId: e.chatId, messageId: 0, to: e.email, subject: asunto, cuerpo, threadId: e.threadId, messageIdHeader: e.messageIdHeader,
    adjuntosDrive: [{ fileId: subido.fileId, nombre: nombreArchivo, mimeType: MIME_DOCX }], declaracionId: declaracion.id,
  });
  await actualizarDeclaracion(declaracion.id, { borradorId: borrador.id });

  const texto = [`📝 Declaración de gastos sin soporte generada para ${e.titular} (${e.empresa}): ${nombreArchivo}`, `Guardada en Drive: ${subido.webViewLink}`, "",
    `✉️ Borrador de correo para ${e.email} (con el documento adjunto):`, `Asunto: ${asunto}`, "", cuerpo].join("\n");
  let messageId = 0;
  try {
    messageId = await sendTelegramMessageWithButtons(e.chatId, texto, [
      [{ text: "📤 Enviar así", callback_data: `draft_enviar:${borrador.id}` }, { text: "✏️ Editar antes de enviar", callback_data: `draft_editar:${borrador.id}` }],
      [{ text: "❌ No enviar", callback_data: `draft_cancelar:${borrador.id}` }],
    ]);
    await actualizarMessageIdBorrador(borrador.id, messageId);
    const confirmado = await obtenerBorradorCorreo(borrador.id);
    if (!confirmado || confirmado.messageId !== messageId) throw new Error("El borrador se mostró, pero su entrega no quedó confirmada en el estado durable.");
  } catch (error) {
    await consumirBorradorCorreo(borrador.id).catch(() => undefined);
    if (messageId > 0) {
      await editTelegramMessage(e.chatId, messageId, "⚠️ Este borrador no quedó guardado de forma segura y sus botones fueron desactivados. El documento sí está en Drive; vuelve a pedir la declaración para reintentar el correo.", []).catch(() => undefined);
    }
    throw error;
  }
  return { declaracion: { ...declaracion, borradorId: borrador.id }, borradorId: borrador.id, messageId };
}

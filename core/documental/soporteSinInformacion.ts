import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extraerDatosFactura, type DatosFactura } from "./extractInvoiceData";
import { generarComprobantePDF } from "../gmail/generarComprobantePDF";
import { obtenerCuerpoCompletoCorreo, obtenerHtmlVisualCorreo, obtenerResumenCorreo } from "../gmail/client";

/**
 * Guarda contra comprobantes sin información contable. Un archivo que no muestra el gasto (un mapa, un icono, una captura sin datos de compra) no
 * puede quedar como comprobante en Holded: Carlos (2026-10-07) — «esto es contabilidad… si pones comprobantes sin información, van a ser
 * problemas legales». Casos reales: la captura de un mapa en el gasto de Antaris y los iconos de Booking en el de Pulse 95.
 *
 * Dos pruebas, las dos necesarias, para no sustituir nunca una foto real de un recibo:
 *  1. El lector marcó que los datos no están en el archivo (`datosEnElDocumento === false`) — solo para imágenes.
 *  2. Una segunda lectura SIN el contexto del correo tampoco encuentra proveedor e importe.
 * Si ambas se cumplen y el archivo viene de un correo, el comprobante pasa a ser el PDF generado desde el cuerpo de ese correo.
 */
export interface DependenciasSoporteSinInformacion {
  leerSinContexto: typeof extraerDatosFactura;
  generarPdf: typeof generarComprobantePDF;
  cuerpo: typeof obtenerCuerpoCompletoCorreo;
  html: typeof obtenerHtmlVisualCorreo;
  resumen: typeof obtenerResumenCorreo;
  escribir: (ruta: string, bytes: Buffer) => Promise<void>;
}

const REALES: DependenciasSoporteSinInformacion = {
  leerSinContexto: extraerDatosFactura,
  generarPdf: generarComprobantePDF,
  cuerpo: obtenerCuerpoCompletoCorreo,
  html: obtenerHtmlVisualCorreo,
  resumen: obtenerResumenCorreo,
  escribir: async (ruta, bytes) => {
    await mkdir(join(process.cwd(), "tmp", "uploads"), { recursive: true });
    await writeFile(ruta, bytes);
  },
};

export function esImagen(mimeType: string | undefined): boolean {
  return (mimeType ?? "").toLowerCase().startsWith("image/");
}

/** El archivo, leído solo, no trae ni proveedor ni importe. */
export function lecturaSinDatosContables(d: Pick<DatosFactura, "proveedor" | "monto">): boolean {
  return !(d.proveedor ?? "").trim() || !(Number.isFinite(d.monto) && d.monto > 0);
}

export interface SoporteSustituto { rutaLocal: string; nombreArchivo: string; mimeType: "application/pdf" }

/**
 * Devuelve el comprobante generado desde el cuerpo del correo cuando el archivo no tiene información contable; undefined si el archivo sirve
 * (o si no se puede demostrar lo contrario, o no se pudo generar el PDF: ante la duda se conserva el archivo original).
 */
export async function sustitutoSiElArchivoNoTieneInformacion(
  params: { rutaLocal: string; mimeType: string | undefined; nombreArchivo: string; datos: DatosFactura; mensajeIdGmail: string | undefined },
  deps: DependenciasSoporteSinInformacion = REALES
): Promise<SoporteSustituto | undefined> {
  if (params.datos.datosEnElDocumento !== false || !esImagen(params.mimeType) || !params.mensajeIdGmail) return undefined;
  const sola = await deps.leerSinContexto(params.rutaLocal, params.mimeType, undefined, params.nombreArchivo);
  if (!lecturaSinDatosContables(sola)) return undefined;
  const [resumen, cuerpo, html] = await Promise.all([deps.resumen(params.mensajeIdGmail), deps.cuerpo(params.mensajeIdGmail), deps.html(params.mensajeIdGmail)]);
  const pdf = await deps.generarPdf({ de: resumen.de, asunto: resumen.asunto, fecha: resumen.fecha, cuerpoCompleto: cuerpo, htmlOriginal: html }, params.datos);
  const rutaLocal = join(process.cwd(), "tmp", "uploads", `${Date.now()}_comprobante_desde_cuerpo.pdf`);
  await deps.escribir(rutaLocal, pdf);
  return { rutaLocal, nombreArchivo: "comprobante_desde_cuerpo.pdf", mimeType: "application/pdf" };
}

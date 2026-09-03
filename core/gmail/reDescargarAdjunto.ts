import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { descargarAdjunto } from "./client";

/**
 * Causa raíz real, encontrada en vivo (2026-09-03): un gasto se creó en
 * Holded SIN su comprobante — "ENOENT: no such file or directory, open
 * '/app/tmp/uploads/...'". La copia local del adjunto (tmp/uploads) NO
 * sobrevive un redeploy de Railway, pero la propuesta que la referencia
 * (Sheets) sí — así que cualquier adjunto que quede pendiente de resolver
 * durante un redeploy (frecuente en desarrollo activo, y ahora más probable
 * con los TTLs largos que ya usan estas propuestas) pierde su copia de
 * trabajo, aunque el archivo ORIGINAL siga intacto en Gmail.
 *
 * Pedido explícito de Carlos: un gasto nunca puede quedar creado sin su
 * soporte ("no hay gastos en la contabilidad que puedan ser creados sin
 * comprobante, es ilegal") — antes de rendirse y avisar del error, se
 * intenta recuperar el archivo real desde su fuente durable (Gmail), no
 * desde la copia de trabajo efímera.
 */
export async function reDescargarAdjuntoSiFalta(
  rutaLocal: string,
  origen: { mensajeIdGmail?: string; attachmentIdGmail?: string } | undefined
): Promise<boolean> {
  if (!origen?.mensajeIdGmail || !origen?.attachmentIdGmail) return false;

  try {
    const bytes = await descargarAdjunto(origen.mensajeIdGmail, origen.attachmentIdGmail);
    await mkdir(dirname(rutaLocal), { recursive: true });
    await writeFile(rutaLocal, bytes);
    return true;
  } catch (error) {
    console.error("[reDescargarAdjunto] No se pudo volver a descargar el adjunto original de Gmail:", error);
    return false;
  }
}

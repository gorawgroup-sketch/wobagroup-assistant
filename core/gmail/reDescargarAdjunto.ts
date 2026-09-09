import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { descargarAdjunto, obtenerCuerpoCompletoCorreo } from "./client";
import { generarComprobantePDF } from "./generarComprobantePDF";

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

/**
 * Hallazgo real de auditoría (Carlos, 2026-09-08): reDescargarAdjuntoSiFalta (arriba) solo recupera
 * un adjunto REAL de Gmail (origenAdjuntoGmail, con attachmentId) — pero el camino "sin adjunto real
 * → cuerpo del correo como comprobante" (generarComprobantePDF, ver revisarCorreoNuevo.ts) genera un
 * PDF SINTÉTICO local que nunca tuvo un attachmentId de Gmail que recuperar. Si ese PDF local se
 * pierde (mismo problema: redeploy de Railway entre crear la propuesta y aprobarla), el gasto se
 * creaba SIN comprobante y sin ninguna vía de recuperación — "no descarga el comprobante... deja
 * vacía la transacción". La corrección: si se sabe de qué correo vino (correoOrigen.mensajeIdGmail,
 * que SIEMPRE se guarda, a diferencia de origenAdjuntoGmail que solo aplica a adjuntos reales), se
 * relee el cuerpo del correo fresco desde Gmail (la fuente durable) y se regenera el mismo PDF con
 * los datos YA extraídos en la propuesta (proveedor/monto/moneda/fecha/concepto/numeroDocumento) —
 * nunca se vuelve a pedir la extracción a Claude, solo se reconstruye el documento con lo que ya se
 * sabía con certeza.
 */
export async function regenerarComprobanteDesdeCuerpoSiFalta(
  rutaLocal: string,
  propuesta: {
    correoOrigen?: { de: string; asunto: string; mensajeIdGmail?: string };
    proveedor: string;
    monto: number;
    moneda: string;
    fecha: string;
    concepto: string;
    numeroDocumento?: string;
    lineas: Array<{ concepto: string; base: number; tipoIvaPct: number }>;
  }
): Promise<boolean> {
  const mensajeIdGmail = propuesta.correoOrigen?.mensajeIdGmail;
  if (!mensajeIdGmail) return false;

  try {
    const cuerpoCompleto = await obtenerCuerpoCompletoCorreo(mensajeIdGmail);
    const bytes = await generarComprobantePDF(
      {
        de: propuesta.correoOrigen?.de ?? "",
        asunto: propuesta.correoOrigen?.asunto ?? "",
        fecha: propuesta.fecha,
        cuerpoCompleto,
      },
      {
        esFacturaOGasto: true,
        proveedor: propuesta.proveedor,
        monto: propuesta.monto,
        moneda: propuesta.moneda,
        fecha: propuesta.fecha,
        concepto: propuesta.concepto,
        numeroDocumento: propuesta.numeroDocumento,
        // Inerte acá: generarComprobantePDF no lee este campo, solo reconstruye visualmente el PDF.
        // La decisión real de si discriminar IVA ya quedó tomada en propuesta.lineas cuando se creó
        // la propuesta original.
        reciboSimplificado: false,
        lineas: propuesta.lineas,
        empresaProbable: "desconocida",
        confianza: "alta",
        razon: "Regenerado tras perder la copia local — datos reutilizados de la propuesta ya extraída, no se volvió a pedir extracción.",
      }
    );
    await mkdir(dirname(rutaLocal), { recursive: true });
    await writeFile(rutaLocal, bytes);
    return true;
  } catch (error) {
    console.error("[reDescargarAdjunto] No se pudo regenerar el comprobante desde el cuerpo del correo:", error);
    return false;
  }
}

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extraerDatosFactura } from "../../documental/extractInvoiceData";
import { transcribirParaCaptura } from "../../documental/transcribeForCapture";
import { descargarAdjunto } from "../../gmail/client";
import { extraerTextoDeterminista } from "../../documental/extractReadableText";
import type { DependenciasAdjuntos, LecturaVisual } from "./adjuntos";

/**
 * Lectura visual REAL de un adjunto (PDF/imagen) para el clasificador. Reutiliza las lecturas que ya existen —no hay un lector
 * nuevo—: la extracción de factura y, solo si no es un comprobante de gasto, la transcripción de captura. Memoriza por
 * contenido (30 min) para que reintentos o reclasificaciones del mismo correo no vuelvan a gastar IA.
 */
const VIGENCIA_MS = 30 * 60_000;
const memoria = new Map<string, { hasta: number; lectura: Promise<LecturaVisual> }>();

const dinero = (n: number): string => new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

async function leer(bytes: Buffer, mimeType: string, nombre: string, contexto: string): Promise<LecturaVisual> {
  const carpeta = await mkdtemp(join(tmpdir(), "lectura-adjunto-"));
  try {
    const ruta = join(carpeta, nombre.replace(/[^\w.\-]+/g, "_") || "adjunto");
    await writeFile(ruta, bytes);
    const d = await extraerDatosFactura(ruta, mimeType, contexto, nombre);
    if (d.esFacturaOGasto) {
      return { esGasto: true, resumen: [d.proveedor, d.monto ? `${dinero(d.monto)} ${d.moneda}` : "", d.fecha].filter(Boolean).join(" · ") };
    }
    return { esGasto: false, texto: await transcribirParaCaptura(ruta, mimeType, contexto) };
  } finally {
    await rm(carpeta, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const dependenciasConVision: DependenciasAdjuntos = {
  descargar: (correoId, a) => descargarAdjunto(correoId, a.attachmentId),
  extraer: extraerTextoDeterminista,
  leerVisual: (bytes, mimeType, nombre, contexto) => {
    const clave = createHash("sha256").update(bytes).digest("hex");
    const previa = memoria.get(clave);
    if (previa && previa.hasta > Date.now()) return previa.lectura;
    if (memoria.size >= 200) memoria.clear();
    const lectura = leer(bytes, mimeType, nombre, contexto);
    memoria.set(clave, { hasta: Date.now() + VIGENCIA_MS, lectura });
    // Un fallo no se memoriza: el siguiente intento vuelve a leer.
    lectura.catch(() => memoria.delete(clave));
    return lectura;
  },
};

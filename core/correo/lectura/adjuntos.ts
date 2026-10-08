import { extraerTextoDeterminista, esFormatoVisual } from "../../documental/extractReadableText";
import { descargarAdjunto, type AdjuntoCorreo } from "../../gmail/client";

/**
 * Lectura de los adjuntos para el clasificador de correo, para que una petición escrita en un adjunto no se pierda.
 *  · Word, Excel, PowerPoint, CSV, texto y HTML: SIN IA (extractor determinista).
 *  · PDF e imágenes: con visión, pero solo lo justo — primero la lectura de factura (la misma del camino de documentos); si NO
 *    es un comprobante de gasto (una carta, una circular, una captura) se transcribe para que sus peticiones entren al análisis.
 *    Una factura entra como una línea de resumen, sin transcribirla. Tope de 3 lecturas visuales por correo, sin imágenes
 *    pequeñas (logos de firma) y con un interruptor (`WOBI_LECTURA_ADJUNTOS_VISUAL=false`).
 *  · Lo que no se lee se declara «no leído en este paso» para que el modelo no concluya nada sobre ello.
 * Medido el 07-10 en 58 correos reales con adjuntos: 0 legibles sin IA, 109 PDF/imágenes/otros — por eso la visión.
 */
export const MAX_ADJUNTOS_LEIDOS = 6;
export const MAX_LECTURAS_VISUALES = 3;
export const MIN_BYTES_IMAGEN = 20 * 1024;
export const MAX_BYTES_ADJUNTO = 6 * 1024 * 1024;
export const MAX_CARACTERES_ADJUNTO = 6_000;
export const MAX_CARACTERES_TOTAL = 18_000;

export interface AdjuntoLeido {
  nombre: string;
  mimeType: string;
  estado: "leido" | "no_leido";
  /** «texto» (leído sin IA), «factura» (comprobante de gasto: solo resumen), «documento» (transcrito con visión). */
  clase?: "texto" | "factura" | "documento";
  /** Resumen de una línea de un comprobante de gasto (clase «factura»). */
  resumen?: string;
  /** Extracto del texto (solo «leido»). */
  texto?: string;
  truncado?: boolean;
  /** Por qué no se leyó (solo «no_leido»). */
  motivo?: string;
}

export interface LecturaVisual { esGasto: boolean; resumen?: string; texto?: string }

export interface DependenciasAdjuntos {
  descargar(correoId: string, adjunto: AdjuntoCorreo): Promise<Buffer>;
  extraer(bytes: Buffer, mimeType: string, nombre: string): Promise<string | undefined>;
  /** Lectura con visión (PDF/imagen). Ausente = no se leen. */
  leerVisual?(bytes: Buffer, mimeType: string, nombre: string, contexto: string): Promise<LecturaVisual>;
}

const depsReales: DependenciasAdjuntos = {
  descargar: (correoId, a) => descargarAdjunto(correoId, a.attachmentId),
  extraer: extraerTextoDeterminista,
};

export const lecturaVisualActiva = (env: NodeJS.ProcessEnv = process.env): boolean =>
  (env.WOBI_LECTURA_ADJUNTOS_VISUAL ?? "true").trim().toLowerCase() !== "false";

export async function leerAdjuntosParaClasificador(
  correoId: string,
  adjuntos: AdjuntoCorreo[],
  deps: DependenciasAdjuntos = depsReales,
  contexto = ""
): Promise<AdjuntoLeido[]> {
  const salida: Array<AdjuntoLeido | Promise<AdjuntoLeido>> = [];
  let restante = MAX_CARACTERES_TOTAL;
  let visuales = 0;
  for (const [i, a] of adjuntos.entries()) {
    const base = { nombre: a.filename || `(adjunto ${i + 1})`, mimeType: a.mimeType };
    const noLeido = (motivo: string): AdjuntoLeido => ({ ...base, estado: "no_leido", motivo });
    if (i >= MAX_ADJUNTOS_LEIDOS) { salida.push(noLeido(`solo se leen los primeros ${MAX_ADJUNTOS_LEIDOS} adjuntos`)); continue; }
    if (a.size > MAX_BYTES_ADJUNTO) { salida.push(noLeido("supera el tamaño máximo para este paso")); continue; }

    if (esFormatoVisual(a.mimeType)) {
      if (!deps.leerVisual) { salida.push(noLeido("PDF o imagen: se lee por el camino de documentos, no en este paso")); continue; }
      if (a.mimeType.startsWith("image/") && a.size < MIN_BYTES_IMAGEN) { salida.push(noLeido("imagen pequeña (probable logo de firma)")); continue; }
      if (visuales >= MAX_LECTURAS_VISUALES) { salida.push(noLeido(`solo se leen con visión los primeros ${MAX_LECTURAS_VISUALES} PDF o imágenes`)); continue; }
      visuales += 1;
      // En paralelo: la latencia es la de una lectura, no la suma.
      salida.push((async (): Promise<AdjuntoLeido> => {
        try {
          const bytes = await deps.descargar(correoId, a);
          const v = await deps.leerVisual!(bytes, a.mimeType, base.nombre, contexto);
          if (v.esGasto) return { ...base, estado: "leido", clase: "factura", resumen: v.resumen ?? "comprobante de gasto" };
          const texto = (v.texto ?? "").trim();
          if (!texto) return noLeido("no se pudo transcribir");
          return { ...base, estado: "leido", clase: "documento", texto: texto.slice(0, MAX_CARACTERES_ADJUNTO), truncado: texto.length > MAX_CARACTERES_ADJUNTO };
        } catch (error) {
          console.error(`[lectura/adjuntos] No se pudo leer con visión «${base.nombre}»:`, error instanceof Error ? error.message : error);
          return noLeido("error al leerlo con visión");
        }
      })());
      continue;
    }

    if (restante <= 0) { salida.push(noLeido("se alcanzó el límite de texto de adjuntos de este paso")); continue; }
    try {
      const bytes = await deps.descargar(correoId, a);
      const texto = (await deps.extraer(bytes, a.mimeType, a.filename ?? ""))?.trim();
      if (!texto) { salida.push(noLeido("formato sin texto legible sin IA")); continue; }
      const limite = Math.min(MAX_CARACTERES_ADJUNTO, restante);
      salida.push({ ...base, estado: "leido", clase: "texto", texto: texto.slice(0, limite), truncado: texto.length > limite });
      restante -= Math.min(texto.length, limite);
    } catch (error) {
      console.error(`[lectura/adjuntos] No se pudo leer «${base.nombre}»:`, error instanceof Error ? error.message : error);
      salida.push(noLeido("error al descargarlo o leerlo"));
    }
  }
  return Promise.all(salida);
}

/** Sección de texto para el clasificador; vacía si el correo no trae adjuntos. */
export function seccionAdjuntos(lecturas: AdjuntoLeido[]): string {
  if (lecturas.length === 0) return "";
  const lineas = ["Adjuntos del correo (no concluyas nada sobre los que figuran como no leídos):"];
  for (const a of lecturas) {
    if (a.estado === "leido" && a.clase === "factura") {
      lineas.push(`- «${a.nombre}» — comprobante de gasto (se procesa aparte como gasto): ${a.resumen}`);
    } else if (a.estado === "leido") {
      lineas.push(`- «${a.nombre}» — leído${a.clase === "documento" ? " con visión (NO es un comprobante de gasto)" : ""}${a.truncado ? ", solo el principio" : ""}:\n${a.texto}`);
    } else {
      lineas.push(`- «${a.nombre}» — NO leído en este paso: ${a.motivo}.`);
    }
  }
  return lineas.join("\n");
}

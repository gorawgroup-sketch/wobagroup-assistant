/**
 * Resumen de la última revisión del vigilante, guardado en su memoria (clave `ultima_revision`) para que Cerebro pueda
 * mostrar «última revisión: hoy 08:35 — 1 cargo en tránsito» sin volver a leer el banco.
 */
import type { ResultadoVigilante } from "./vigilante";
import { describirMovimiento, etiquetaPoliza } from "./informe";

export const CLAVE_ULTIMA_REVISION = "ultima_revision";

export interface UltimaRevisionVigilante {
  /** Instante de la revisión (ISO). */
  fecha: string;
  confirmados: number;
  /** Cargos vistos que aún no se dan por pagados, en una línea cada uno. */
  enTransito: string[];
  devoluciones: number;
  cargosARevisar: number;
  correosNuevos: number;
  advertencias: string[];
}

export function resumirRevision(r: ResultadoVigilante, ahora: Date): UltimaRevisionVigilante {
  return {
    fecha: ahora.toISOString(),
    confirmados: r.contenido.confirmados.length,
    enTransito: r.contenido.enTransito.map((t) => `${t.polizas.map(etiquetaPoliza).join(" + ")}: ${describirMovimiento(t.movimiento)}`),
    devoluciones: r.contenido.devoluciones.length,
    cargosARevisar: r.contenido.cargos.length,
    correosNuevos: r.contenido.correos.length,
    advertencias: [...r.contenido.advertencias, ...r.contenido.fallosPersistentes].map((a) => a.slice(0, 240)),
  };
}

export function parsearUltimaRevision(crudo: string | undefined): UltimaRevisionVigilante | null {
  if (!crudo) return null;
  try {
    const v = JSON.parse(crudo) as Partial<UltimaRevisionVigilante>;
    if (typeof v.fecha !== "string") return null;
    return {
      fecha: v.fecha,
      confirmados: Number(v.confirmados) || 0,
      enTransito: Array.isArray(v.enTransito) ? v.enTransito.map(String) : [],
      devoluciones: Number(v.devoluciones) || 0,
      cargosARevisar: Number(v.cargosARevisar) || 0,
      correosNuevos: Number(v.correosNuevos) || 0,
      advertencias: Array.isArray(v.advertencias) ? v.advertencias.map(String) : [],
    };
  } catch {
    return null;
  }
}

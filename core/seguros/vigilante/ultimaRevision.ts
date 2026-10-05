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
  /** Cargos vistos que aún no se dan por pagados (todos los que siguen así ahora, no solo los nuevos), en una línea cada uno. */
  enTransito: string[];
  devoluciones: number;
  /** Cargos de seguros que siguen sin encajar ahora. */
  cargosARevisar: number;
  correosNuevos: number;
  advertencias: string[];
}

/**
 * Lo que persiste (cargos en tránsito, cargos que no encajan) sale de la SITUACIÓN de ahora, no de lo nuevo: un cargo ya
 * avisado sigue sin estar confirmado y el panel debe seguir mostrándolo hasta que se resuelva. Lo que ocurre una vez por
 * revisión (pagos confirmados, devoluciones, correos nuevos) sí es de esa revisión.
 */
export function resumirRevision(r: ResultadoVigilante, ahora: Date): UltimaRevisionVigilante {
  return {
    fecha: ahora.toISOString(),
    confirmados: r.contenido.confirmados.length,
    enTransito: r.situacion.enTransito.map((t) => `${t.polizas.map(etiquetaPoliza).join(" + ")}: ${describirMovimiento(t.movimiento)}`),
    devoluciones: r.contenido.devoluciones.length,
    cargosARevisar: r.situacion.cargos.length,
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

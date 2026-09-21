import type { ProblemaEstructuraDatos } from "../google/cashflowLayout";

/**
 * Funciones puras del cashflow, en un módulo propio SIN dependencias pesadas: cruceHoldedCashflow arrastra el
 * cliente de Holded, Postgres, etc., y la búsqueda del cashflow (y sus tests) no debe cargar todo eso solo para
 * interpretar un importe o clasificar un problema de lectura. cruceHoldedCashflow las reexporta.
 */

/**
 * Hallazgo real de auditoría (2026-09-18, corrigiendo una regresión propia del mismo día — PR #109):
 * obtenerUltimaVerificacionEstructura() junta 4 problemas de severidad muy distinta bajo un mismo
 * array plano. 3 son de fila (concepto sin importe, celda con formato inválido, hueco de filas vacías)
 * — no pierden ninguna categoría completa, solo una fila puntual; correctamente informativos, nunca
 * deben bloquear el reporte. El cuarto (descubrirEncabezado en cashflowLayout.ts no localiza de forma
 * inequívoca el título/encabezado de una sección — 0 o más de 1 candidato) es GRAVE: la categoría
 * entera devuelve cero filas, indistinguible de "de verdad no hay gastos" para quien lee el reporte.
 * Mover TODO el array a advertenciasEstructura (no bloqueante) fue una sobrecorrección: dejaba pasar
 * silenciosamente justo el caso severo que este mecanismo existe para atrapar. Se distingue por texto
 * porque ProblemaEstructuraDatos no lleva un campo de severidad — ver los dos mensajes exactos en
 * obtenerDisposiciones (cashflowLayout.ts).
 */
export function esProblemaEstructuraSevero(problema: ProblemaEstructuraDatos): boolean {
  return (
    problema.detalle.includes("no pudo localizar de forma inequívoca") ||
    problema.detalle.includes("encontró más de una tabla válida")
  );
}

export function parsearImporteCashflow(valor: string): number {
  const original = String(valor ?? "").trim();
  if (!original) return 0;
  const negativoPorParentesis = /^\(.*\)$/.test(original);
  let limpio = original.replace(/[^0-9,.-]/g, "").replace(/-/g, "");
  const ultimoPunto = limpio.lastIndexOf(".");
  const ultimaComa = limpio.lastIndexOf(",");

  if (ultimoPunto >= 0 && ultimaComa >= 0) {
    const decimal = ultimoPunto > ultimaComa ? "." : ",";
    const miles = decimal === "." ? "," : ".";
    limpio = limpio.split(miles).join("");
    if (decimal === ",") limpio = limpio.replace(",", ".");
  } else if (ultimaComa >= 0) {
    const decimales = limpio.length - ultimaComa - 1;
    limpio = decimales > 0 && decimales <= 2 ? limpio.replace(",", ".") : limpio.replace(/,/g, "");
  } else if (ultimoPunto >= 0) {
    const decimales = limpio.length - ultimoPunto - 1;
    if (decimales === 3 && /^\d{1,3}(?:\.\d{3})+$/.test(limpio)) limpio = limpio.replace(/\./g, "");
  }

  const numero = Number(limpio);
  if (!Number.isFinite(numero)) return 0;
  return negativoPorParentesis || original.includes("-") ? -numero : numero;
}

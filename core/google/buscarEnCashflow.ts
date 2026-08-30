import { fetchDetalleRegistros, type DetalleRegistro } from "./cashflowSheet";
import { textosParecidos } from "../utils/textoParecido";

function textoDe(r: DetalleRegistro): string {
  return [r.cliente, r.proyecto, r.concepto].filter(Boolean).join(" ").toLowerCase();
}

export interface ResultadoBusquedaCashflow {
  coincidencias: DetalleRegistro[];
  /** true si NINGUNA coincidencia fue por substring exacto (todas vinieron del fallback por palabras parecidas). */
  aproximado: boolean;
}

/**
 * Busca en TODA la hoja DATOS (todas las categorías) un concepto/proveedor,
 * primero por substring exacto y si no hay ninguno, por palabras parecidas
 * (ver core/utils/textoParecido.ts) — misma lógica que ya usa
 * consultar_cashflow_detalle, factorizada aquí para que otras herramientas
 * (ej. consultar_proximas_alertas) puedan reutilizarla sin duplicarla ni
 * depender de que el modelo encadene una llamada aparte.
 */
export async function buscarEnCashflowPorConcepto(
  concepto: string,
  empresaFiltro?: "WOBA" | "EWORKS"
): Promise<ResultadoBusquedaCashflow> {
  const registros = (await fetchDetalleRegistros()).filter((r) => !empresaFiltro || r.empresa === empresaFiltro);
  const objetivo = concepto.trim().toLowerCase();
  if (!objetivo) return { coincidencias: [], aproximado: false };

  const exactos = registros.filter((r) => textoDe(r).includes(objetivo));
  if (exactos.length > 0) return { coincidencias: exactos, aproximado: false };

  const aproximados = registros.filter((r) => textosParecidos(concepto, textoDe(r)));
  return { coincidencias: aproximados, aproximado: aproximados.length > 0 };
}

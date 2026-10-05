import { inferirTagsCategoria, obtenerCompraHoldedPorId, type CompraHoldedCruda } from "../holded/write";
import type { Empresa } from "../holded/client";

/** Texto máximo que se añade al concepto de búsqueda (la descripción de una compra puede ser larga). */
const MAX_TEXTO_COMPRA = 500;

/**
 * Caso real 2026-10-05 (hotel MOME, Footprint): al crear el gasto, la pregunta «¿concilio?» y la búsqueda inmediata
 * guardaban como descripción solo «contacto — importe moneda» y tiraban el concepto («Hospedaje Hotel MOME…»). La
 * búsqueda usa esa descripción para comprobar la categoría contra el cargo: sin ella, un cargo de categoría conocida
 * («The Cut Hotel») se descartaba como incompatible aunque importe×tasa cuadraba (+1,8 %) y la propuesta ya lo había
 * ofrecido. Resultado: «No encontré un movimiento bancario libre» con el gasto ya creado.
 *
 * Fuente de verdad: la propia compra en Holded (descripción, líneas y etiquetas). Solo se lee si la descripción recibida
 * no permite inferir ninguna categoría, para no añadir una lectura a cada conciliación. Un fallo de lectura no impide
 * buscar: se usa la descripción recibida, como antes.
 */
export async function conceptoParaBusqueda(
  empresa: Empresa,
  gastoId: string,
  descripcionGasto: string,
  proveedor: string | undefined,
  leerCompra: (empresa: Empresa, id: string) => Promise<CompraHoldedCruda> = obtenerCompraHoldedPorId
): Promise<string> {
  if (inferirTagsCategoria(descripcionGasto, proveedor ?? "").length > 0) return descripcionGasto;
  let compra: CompraHoldedCruda;
  try {
    compra = await leerCompra(empresa, gastoId);
  } catch (error) {
    console.error("[conceptoParaBusqueda] No se pudo leer la compra para recuperar su concepto (se busca con la descripción recibida):", error);
    return descripcionGasto;
  }
  const etiquetas = Array.isArray(compra.tags) ? (compra.tags as unknown[]).filter((t): t is string => typeof t === "string") : [];
  const textos = [compra.description, ...(compra.lines ?? []).map((l) => l.name), ...etiquetas]
    .filter((t): t is string => typeof t === "string" && t.trim() !== "");
  const unico = [...new Set(textos.map((t) => t.trim()))].join(" · ").slice(0, MAX_TEXTO_COMPRA);
  return unico ? `${descripcionGasto} — ${unico}` : descripcionGasto;
}

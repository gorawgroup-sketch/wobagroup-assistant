import { buscarCargoMayorDelProveedor, buscarMovimientoAproximado, buscarMovimientoSimilar, type MovimientoBancarioCandidato } from "../holded/write";
import { esProveedorNoIdentificado } from "../holded/duplicateSignals";
import { crearTrazaBusqueda, type TrazaBusqueda } from "../holded/trazaBusqueda";
import type { Empresa } from "../holded/client";

/**
 * ÚNICA jerarquía para elegir el cargo bancario de una propuesta de gasto (la usan la renovación de botones, la corrección de
 * moneda/monto/clasificación y, con su propia rama de tipo de cambio, el alta de la propuesta):
 *   1. cargo exacto compatible por nombre/categoría (o «aprendido»: un humano ya lo confirmó para este proveedor);
 *   2. cargo aproximado que sí coincide por nombre (importe cercano, no exacto);
 *   3. cargo exacto SOLO «por confirmar» (nombre distinto, categoría desconocida): último recurso, siempre con aviso.
 *   4. si no hay nada de lo anterior, cargos MAYORES del mismo proveedor (cargoMayor.ts): nunca recomendados, solo como
 *      opciones «Conciliar con #N» que dejan el cargo parcialmente conciliado.
 * Antes cada flujo repetía esta cadena a su manera y unos olvidaban el paso 2, o no volvían a buscar tras corregir el importe.
 */
export interface ResultadoCargoPropuesta {
  movimientoEncontrado: boolean;
  /** Un único cargo recomendado (exacto o aproximado): habilita «Crear y conciliar» directamente. */
  movimientoRecomendado?: MovimientoBancarioCandidato;
  /** Varios cargos posibles: el operador elige con «Conciliar con #N». */
  movimientosAmbiguos: MovimientoBancarioCandidato[];
  /** Lo que se persiste en la propuesta: el recomendado si lo hay, si no los ambiguos. */
  movimientosPersistidos: MovimientoBancarioCandidato[];
  traza: TrazaBusqueda;
}

export interface CriteriosCargoPropuesta {
  empresa: Empresa;
  proveedor: string;
  concepto: string;
  monto: number;
  moneda: string;
  fecha: string;
  /**
   * false cuando la búsqueda se repite bajo una decisión que el operador YA marcó por índice («Conciliar con #N»):
   * una lista nueva con un cargo mayor en ese mismo índice lo conciliaría sin que nadie lo hubiera elegido.
   */
  ofrecerCargoMayor?: boolean;
}

const depsReales = { similar: buscarMovimientoSimilar, aproximado: buscarMovimientoAproximado, cargoMayor: buscarCargoMayorDelProveedor };

export async function buscarCargoParaPropuesta(
  c: CriteriosCargoPropuesta,
  deps: {
    similar: typeof buscarMovimientoSimilar;
    aproximado: typeof buscarMovimientoAproximado;
    cargoMayor?: typeof buscarCargoMayorDelProveedor;
  } = depsReales
): Promise<ResultadoCargoPropuesta> {
  const traza = crearTrazaBusqueda();
  const exactos = await deps.similar(
    c.empresa,
    { monto: c.monto, fecha: c.fecha, moneda: c.moneda, proveedor: c.proveedor, concepto: c.concepto, incluirPorConfirmar: true, traza }
  );
  const soloPorConfirmar = exactos.length > 0 && exactos.every((m) => m.compatibilidad === "por_confirmar");

  let recomendado: MovimientoBancarioCandidato | undefined;
  let ambiguos: MovimientoBancarioCandidato[] = [];
  // Si el barrido aproximado falla, no se puede afirmar «no hay cargo por ese importe»: tampoco se ofrece uno mayor.
  let busquedaCompleta = true;

  if ((exactos.length === 0 || soloPorConfirmar) && c.proveedor.trim() && !esProveedorNoIdentificado(c.proveedor)) {
    try {
      const aproximados = await deps.aproximado(c.empresa, { monto: c.monto, fecha: c.fecha, moneda: c.moneda, proveedor: c.proveedor });
      if (aproximados.length > 0) recomendado = { ...aproximados[0], origenCoincidencia: "aproximada" };
    } catch (error) {
      busquedaCompleta = false;
      // Un fallo del segundo barrido de Holded no debe hacer perder los cargos exactos ya encontrados.
      console.error("[buscarCargoParaPropuesta] Error buscando cargo aproximado (se sigue con los exactos):", error instanceof Error ? error.message : error);
    }
  }
  if (!recomendado) {
    if (exactos.length === 1) recomendado = { ...exactos[0], origenCoincidencia: "exacta" };
    else if (exactos.length > 1) ambiguos = exactos;
  }
  if (!recomendado && ambiguos.length === 0 && busquedaCompleta && c.ofrecerCargoMayor !== false && deps.cargoMayor &&
      c.proveedor.trim() && !esProveedorNoIdentificado(c.proveedor)) {
    try {
      ambiguos = await deps.cargoMayor(c.empresa, { monto: c.monto, fecha: c.fecha, moneda: c.moneda, proveedor: c.proveedor, concepto: c.concepto });
    } catch (error) {
      console.error("[buscarCargoParaPropuesta] Error buscando un cargo mayor del proveedor (se sigue sin él):", error instanceof Error ? error.message : error);
    }
  }

  return {
    movimientoEncontrado: Boolean(recomendado),
    movimientoRecomendado: recomendado,
    movimientosAmbiguos: ambiguos,
    movimientosPersistidos: recomendado ? [recomendado] : ambiguos,
    traza,
  };
}

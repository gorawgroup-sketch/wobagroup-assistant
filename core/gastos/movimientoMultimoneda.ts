import type { Empresa } from "../holded/client";
import {
  buscarMovimientoAproximado,
  buscarMovimientoSimilar,
  proveedorPareceEnDescripcion,
  movimientoCompatibleConGasto,
  compatibleSoloPorCategoria,
  DIAS_MAXIMOS_COINCIDENCIA_SOLO_CATEGORIA,
  type MovimientoBancarioCandidato,
} from "../holded/write";
import { obtenerTasaCambioHistorica } from "../utils/exchangeRate";

export interface DependenciasBusquedaMultimoneda {
  obtenerTasa: typeof obtenerTasaCambioHistorica;
  buscarCercanos: typeof buscarMovimientoSimilar;
  buscarPorNombre: typeof buscarMovimientoAproximado;
}

const DEPENDENCIAS_REALES: DependenciasBusquedaMultimoneda = {
  obtenerTasa: obtenerTasaCambioHistorica,
  buscarCercanos: buscarMovimientoSimilar,
  buscarPorNombre: buscarMovimientoAproximado,
};

function diasDeDiferencia(a: string, b: string): number {
  const ma = new Date(a).getTime();
  const mb = new Date(b).getTime();
  return Number.isFinite(ma) && Number.isFinite(mb) ? Math.abs(ma - mb) / 86_400_000 : Number.MAX_SAFE_INTEGER;
}

/**
 * Último nivel de búsqueda cuando no hubo coincidencia en la moneda declarada. Convierte el importe
 * de la factura a cada moneda de cuenta REAL de la misma empresa usando la tasa histórica del BCE y
 * vuelve a buscar en todas sus cuentas. La tasa es solo una referencia: admite hasta 3% con categoría compatible,
 * o la banda aproximada existente cuando además coincide el proveedor. Devuelve candidatos para que
 * el usuario elija; nunca concilia ni cambia la moneda del gasto automáticamente.
 */
export async function buscarMovimientosPorTipoCambio(
  empresa: Empresa,
  criterios: { monto: number; moneda: string; fecha: string; proveedor?: string; concepto?: string },
  monedasCuentas: Iterable<string>,
  dependencias: DependenciasBusquedaMultimoneda = DEPENDENCIAS_REALES
): Promise<MovimientoBancarioCandidato[]> {
  const monedaOrigen = criterios.moneda.toUpperCase().trim();
  if (!monedaOrigen || !Number.isFinite(criterios.monto) || criterios.monto === 0) return [];

  const monedasDestino = Array.from(
    new Set(Array.from(monedasCuentas, (moneda) => moneda.toUpperCase().trim()))
  ).filter((moneda) => moneda && moneda !== monedaOrigen);
  const resultados = new Map<string, MovimientoBancarioCandidato>();

  for (const monedaDestino of monedasDestino) {
    let tasa: number | undefined;
    try {
      tasa = await dependencias.obtenerTasa(criterios.fecha, monedaOrigen, monedaDestino);
    } catch (error) {
      console.error(`[movimientoMultimoneda] Error consultando tasa ${monedaOrigen}->${monedaDestino}:`, error);
      continue;
    }
    if (tasa === undefined || !Number.isFinite(tasa) || tasa <= 0) continue;

    const montoReferencia = Math.abs(criterios.monto) * tasa;
    const toleranciaSinNombre = Math.max(0.05, montoReferencia * 0.03);
    let cercanos: MovimientoBancarioCandidato[] = [];
    let porNombre: MovimientoBancarioCandidato[] = [];

    try {
      cercanos = await dependencias.buscarCercanos(
        empresa,
        { monto: montoReferencia, moneda: monedaDestino, fecha: criterios.fecha, proveedor: criterios.proveedor, concepto: criterios.concepto },
        toleranciaSinNombre
      );
    } catch (error) {
      console.error(`[movimientoMultimoneda] Error buscando movimientos cercanos en ${monedaDestino}:`, error);
    }

    if (criterios.proveedor?.trim()) {
      try {
        porNombre = await dependencias.buscarPorNombre(empresa, {
          monto: montoReferencia,
          moneda: monedaDestino,
          fecha: criterios.fecha,
          proveedor: criterios.proveedor,
        });
      } catch (error) {
        console.error(`[movimientoMultimoneda] Error buscando por proveedor en ${monedaDestino}:`, error);
      }
    }

    for (const candidato of [...cercanos, ...porNombre]) {
      // Apply the same semantic guard before showing text, persisting or rendering buttons.
      if (!movimientoCompatibleConGasto(criterios.proveedor ?? "", criterios.concepto ?? "", candidato.descripcion, { nucleoDeMarca: true })) continue;
      const clave = `${candidato.accountId}:${candidato.movementId}`;
      const diferenciaMonto = Math.abs(Math.abs(candidato.monto) - montoReferencia);
      const enriquecido: MovimientoBancarioCandidato = {
        ...candidato,
        origenCoincidencia: "tipo_cambio",
        // Solo coincide la categoría y la fecha está lejos (caso real: un café de Bogotá en COP frente al cargo de un
        // restaurante de Puerto Rico): se ofrece igualmente, pero con el aviso de «nombre distinto».
        ...(compatibleSoloPorCategoria(criterios.proveedor ?? "", criterios.concepto ?? "", candidato.descripcion, { nucleoDeMarca: true }) &&
        diasDeDiferencia(candidato.fecha, criterios.fecha) > DIAS_MAXIMOS_COINCIDENCIA_SOLO_CATEGORIA
          ? { compatibilidad: "por_confirmar" as const }
          : {}),
        montoReferencia,
        monedaOrigenReferencia: monedaOrigen,
        tasaReferencia: tasa,
        diferenciaMonto,
        coincideProveedor: criterios.proveedor
          ? proveedorPareceEnDescripcion(criterios.proveedor, candidato.descripcion)
          : false,
      };
      const existente = resultados.get(clave);
      if (!existente || diferenciaMonto < (existente.diferenciaMonto ?? Number.POSITIVE_INFINITY)) {
        resultados.set(clave, enriquecido);
      }
    }
  }

  return [...resultados.values()]
    .sort((a, b) => {
      if (a.coincideProveedor !== b.coincideProveedor) return a.coincideProveedor ? -1 : 1;
      const diferenciaRelativaA = (a.diferenciaMonto ?? Number.POSITIVE_INFINITY) / Math.max(a.montoReferencia ?? 0, 0.01);
      const diferenciaRelativaB = (b.diferenciaMonto ?? Number.POSITIVE_INFINITY) / Math.max(b.montoReferencia ?? 0, 0.01);
      if (diferenciaRelativaA !== diferenciaRelativaB) return diferenciaRelativaA - diferenciaRelativaB;
      return diasDeDiferencia(a.fecha, criterios.fecha) - diasDeDiferencia(b.fecha, criterios.fecha);
    })
    .slice(0, 5);
}

export function describirMovimientoMultimoneda(
  movimiento: MovimientoBancarioCandidato,
  indice?: number
): string {
  const prefijo = indice === undefined ? "" : `  ${indice + 1}. `;
  const referencia =
    movimiento.montoReferencia !== undefined && movimiento.tasaReferencia !== undefined && movimiento.monedaOrigenReferencia
      ? `; referencia ${movimiento.montoReferencia.toFixed(2)} ${movimiento.moneda} ` +
        `a tasa ${movimiento.tasaReferencia.toFixed(4)} desde ${movimiento.monedaOrigenReferencia}`
      : "";
  const nombre = movimiento.coincideProveedor
    ? "; además coincide el proveedor"
    : movimiento.compatibilidad === "por_confirmar" ? "; ⚠️ nombre distinto: confírmalo" : "";
  return (
    `${prefijo}"${movimiento.descripcion || "(sin descripción)"}" — ${movimiento.monto.toFixed(2)} ` +
    `${movimiento.moneda} (${movimiento.fecha}${referencia}${nombre})`
  );
}

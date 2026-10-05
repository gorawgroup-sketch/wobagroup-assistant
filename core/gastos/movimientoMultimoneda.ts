import type { Empresa } from "../holded/client";
import {
  buscarMovimientoAproximado,
  buscarMovimientoSimilar,
  proveedorPareceEnDescripcion,
  movimientoCompatibleConGasto,
  candidatoUtilizableParaGasto,
  type MovimientoBancarioCandidato,
} from "../holded/write";
import { obtenerTasaCambioHistorica } from "../utils/exchangeRate";
import { cargoCorrespondeMejorAOtroRecibo, type MatrizCostes } from "./repartoOptimo";
import { obtenerPropuestasGastoPorEmpresa } from "./gastoProposalSheet";

/** Otro recibo pendiente que puede competir por los mismos cargos (una propuesta ya mostrada). */
export interface ReciboCompetidor {
  id: string;
  monto: number;
  moneda: string;
  fecha: string;
  proveedor: string;
  concepto: string;
}

/**
 * Días máximos entre la fecha de un recibo competidor y la del cargo para que pueda competir por él. Si el cargo no
 * respalda el nombre (por confirmar/aprendido) se exige la misma exactitud que para ofrecerlo: ±1 día.
 */
const DIAS_MAXIMOS_COMPETIDOR = 5;
/** Misma tolerancia relativa que la búsqueda por tipo de cambio (3 %). */
const TOLERANCIA_RELATIVA_CAMBIO = 0.03;

export interface DependenciasBusquedaMultimoneda {
  obtenerTasa: typeof obtenerTasaCambioHistorica;
  /** Recibos pendientes de la empresa que compiten por los mismos cargos (reparto óptimo). */
  obtenerCompetidores?: (empresa: Empresa) => Promise<ReciboCompetidor[]>;
  buscarCercanos: typeof buscarMovimientoSimilar;
  buscarPorNombre: typeof buscarMovimientoAproximado;
}

const DEPENDENCIAS_REALES: DependenciasBusquedaMultimoneda = {
  obtenerTasa: obtenerTasaCambioHistorica,
  obtenerCompetidores: async (empresa) =>
    (await obtenerPropuestasGastoPorEmpresa(empresa)).map((p) => ({
      id: p.id, monto: p.monto, moneda: p.moneda, fecha: p.fecha, proveedor: p.proveedor, concepto: p.concepto,
    })),
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
  criterios: {
    monto: number; moneda: string; fecha: string; proveedor?: string; concepto?: string;
    /**
     * Solo para quien ARMA una propuesta y obliga a elegir «Conciliar con #N»: ofrece también un cargo débito del mismo
     * día (±1) cuyo nombre no se reconoce, con importe dentro de la tolerancia de cambio y sin categoría contradictoria,
     * marcado «por confirmar» (o «aprendido» si ya se confirmó antes). Quien resuelve solo no lo activa.
     */
    incluirPorConfirmar?: boolean;
    /**
     * Solo para quien ARMA una propuesta: antes de ofrecer un cargo, comprueba si otro recibo pendiente de la empresa
     * encaja claramente mejor con él (reparto óptimo, ver repartoOptimo.ts) y, si es así, no se ofrece aquí.
     * `excluirPropuestaId` es la propia propuesta cuando ya existe.
     */
    repartoConPendientes?: { excluirPropuestaId?: string };
  },
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
        {
          monto: montoReferencia, moneda: monedaDestino, fecha: criterios.fecha, proveedor: criterios.proveedor, concepto: criterios.concepto,
          ...(criterios.incluirPorConfirmar ? { incluirPorConfirmar: true, importeAproximadoPorCambio: true } : {}),
        },
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
      const utilizable = candidato.compatibilidad
        ? candidatoUtilizableParaGasto(criterios.proveedor ?? "", criterios.concepto ?? "", candidato)
        : movimientoCompatibleConGasto(criterios.proveedor ?? "", criterios.concepto ?? "", candidato.descripcion, { nucleoDeMarca: true });
      if (!utilizable) continue;
      const clave = `${candidato.accountId}:${candidato.movementId}`;
      const diferenciaMonto = Math.abs(Math.abs(candidato.monto) - montoReferencia);
      const enriquecido: MovimientoBancarioCandidato = {
        ...candidato,
        origenCoincidencia: "tipo_cambio",
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

  // Un cargo que respalda el nombre siempre gana a uno solo «por confirmar»/«aprendido»; entre estos, el aprendido gana.
  const todos = [...resultados.values()];
  const firmes = todos.filter((c) => !c.compatibilidad);
  const aprendidos = todos.filter((c) => c.compatibilidad === "aprendido");
  let elegibles = firmes.length > 0 ? firmes : aprendidos.length > 0 ? aprendidos : todos;
  if (criterios.repartoConPendientes && elegibles.length > 0) {
    elegibles = await retirarCargosDeOtrosRecibos(empresa, criterios, elegibles, monedaOrigen, dependencias);
  }

  return elegibles
    .sort((a, b) => {
      if (a.coincideProveedor !== b.coincideProveedor) return a.coincideProveedor ? -1 : 1;
      const diferenciaRelativaA = (a.diferenciaMonto ?? Number.POSITIVE_INFINITY) / Math.max(a.montoReferencia ?? 0, 0.01);
      const diferenciaRelativaB = (b.diferenciaMonto ?? Number.POSITIVE_INFINITY) / Math.max(b.montoReferencia ?? 0, 0.01);
      if (diferenciaRelativaA !== diferenciaRelativaB) return diferenciaRelativaA - diferenciaRelativaB;
      return diasDeDiferencia(a.fecha, criterios.fecha) - diasDeDiferencia(b.fecha, criterios.fecha);
    })
    .slice(0, 5);
}

/**
 * Quita de la lista los cargos que, en el reparto óptimo entre este recibo y los demás recibos pendientes de la empresa,
 * le tocan a otro (importe×tasa claramente más ajustado). Un fallo al leer los competidores no impide la búsqueda: se
 * ofrece la lista completa, como antes.
 */
async function retirarCargosDeOtrosRecibos(
  empresa: Empresa,
  criterios: { fecha: string; proveedor?: string; concepto?: string; repartoConPendientes?: { excluirPropuestaId?: string } },
  candidatos: MovimientoBancarioCandidato[],
  monedaOrigen: string,
  dependencias: DependenciasBusquedaMultimoneda
): Promise<MovimientoBancarioCandidato[]> {
  if (!dependencias.obtenerCompetidores) return candidatos;
  let competidores: ReciboCompetidor[];
  try {
    competidores = (await dependencias.obtenerCompetidores(empresa))
      .filter((c) => c.id !== criterios.repartoConPendientes?.excluirPropuestaId && Number.isFinite(c.monto) && c.monto > 0);
  } catch (error) {
    console.error("[movimientoMultimoneda] No se pudieron leer los recibos pendientes para el reparto (se ofrece la lista completa):", error);
    return candidatos;
  }
  if (competidores.length === 0) return candidatos;

  const tasas = new Map<string, Promise<number | undefined>>();
  const tasa = (fecha: string, origen: string, destino: string): Promise<number | undefined> => {
    if (origen === destino) return Promise.resolve(1);
    const clave = `${fecha}|${origen}|${destino}`;
    if (!tasas.has(clave)) tasas.set(clave, dependencias.obtenerTasa(fecha, origen, destino));
    return tasas.get(clave)!;
  };

  let matriz: MatrizCostes;
  try {
    matriz = [candidatos.map((c) => {
      const referencia = c.montoReferencia ?? 0;
      return referencia > 0 ? Math.abs(Math.abs(c.monto) - referencia) / referencia : undefined;
    })];
    for (const competidor of competidores) {
      const origen = competidor.moneda.toUpperCase().trim();
      const fila: Array<number | undefined> = [];
      for (const candidato of candidatos) {
        const destino = candidato.moneda.toUpperCase().trim();
        const t = await tasa(competidor.fecha, origen, destino);
        const referencia = t !== undefined && Number.isFinite(t) && t > 0 ? competidor.monto * t : 0;
        const desviacion = referencia > 0 ? Math.abs(Math.abs(candidato.monto) - referencia) / referencia : Infinity;
        const admisible =
          desviacion <= TOLERANCIA_RELATIVA_CAMBIO &&
          diasDeDiferencia(candidato.fecha, competidor.fecha) <= (candidato.compatibilidad ? 1 : DIAS_MAXIMOS_COMPETIDOR) &&
          candidatoUtilizableParaGasto(competidor.proveedor, competidor.concepto, candidato);
        fila.push(admisible ? desviacion : undefined);
      }
      matriz.push(fila);
    }
  } catch (error) {
    // Sin las tasas de los competidores no se puede comparar: se ofrece la lista completa, como antes del reparto.
    console.error("[movimientoMultimoneda] No se pudo calcular el reparto entre recibos pendientes (se ofrece la lista completa):", error);
    return candidatos;
  }

  const conservados = candidatos.filter((c, i) => {
    const retirar = cargoCorrespondeMejorAOtroRecibo(matriz, i);
    if (retirar) console.info(`[movimientoMultimoneda] Cargo ${c.descripcion} ${c.monto} ${c.moneda} reservado a otro recibo pendiente (reparto óptimo) — no se ofrece a ${criterios.proveedor ?? "este recibo"}.`);
    return !retirar;
  });
  return conservados;
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

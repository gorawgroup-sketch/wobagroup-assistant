import { buscarMovimientoSimilar, type MovimientoBancarioCandidato } from "../holded/write";
import type { ConciliacionVerificadaAprendida } from "../holded/conciliacionAprendidaSheet";
import { MonedasCuentasReales } from "../holded/monedasCuentas";
import { construirTecladoGasto, opcionesTecladoDesdePropuesta } from "../gastos/gastoTeclado";
import type { PropuestaGasto } from "../gastos/gastoProposalSheet";

/**
 * Banco de CASOS REALES. Cada incidente de producción se añade aquí como un fichero JSON en `casos/` ANTES de arreglarlo:
 * el caso guarda lo que Holded devolvía (cuentas, movimientos), lo que decía el ticket y la decisión correcta. Se ejecuta
 * con el código real (búsqueda de cargos y teclado) contra un Holded simulado que no permite escrituras. Así una
 * corrección no se puede deshacer sin que falle un caso, y el sistema no repite el mismo error con otro nombre.
 */

export interface CuentaCaso { id: string; name?: string; currency: string; archived?: boolean }
export interface MovimientoCaso {
  id: string; description: string; amount: string; currency: string; booking_date: string; status: string;
  reconciled_amount?: string; accounting_amount?: string | null;
}

export interface CasoBusquedaCargo {
  tipo: "busqueda_cargo";
  id: string;
  descripcion: string;
  fuente: string;
  /** Comportamiento actual que se documenta aunque no sea el deseado: si cambia, el caso falla y hay que decidirlo a propósito. */
  riesgoConocido?: string;
  empresa: "WOBA" | "EWORKS" | "Footprint";
  ticket: { proveedor: string; concepto: string; monto: number; moneda: string; fecha: string };
  cuentas: CuentaCaso[];
  movimientos: Record<string, MovimientoCaso[]>;
  aprendidas?: Array<{ proveedor: string; moneda: string; descripcionMovimiento: string }>;
  esperado: {
    /** Lo que se ofrece al operador al armar la propuesta: id del movimiento y marca (null = compatible por nombre/categoría). */
    candidatos: Array<{ movementId: string; compatibilidad: "por_confirmar" | "aprendido" | null }>;
    /** Lo que vería la búsqueda que puede conciliar sin preguntar (intentarConciliar): nunca por_confirmar ni aprendido. */
    vistoPorConciliacionAutomatica: string[];
    botonesIncluyen?: string[];
    botonesExcluyen?: string[];
  };
}

export interface CasoMonedasCuentas {
  tipo: "monedas_cuentas";
  id: string;
  descripcion: string;
  fuente: string;
  empresa: string;
  cuentas: CuentaCaso[];
  /** Secuencia de lecturas a Holded: "ok" devuelve las cuentas, "error" simula un 502/503. */
  lecturas: Array<{ holded: "ok" | "error"; esperado: string[] | "lanza" }>;
}

export type CasoReal = CasoBusquedaCargo | CasoMonedasCuentas;

/** Holded simulado: nada sale a la red y cualquier escritura hace fallar el caso. */
async function conHoldedSimulado<T>(caso: CasoBusquedaCargo, prueba: () => Promise<T>): Promise<T> {
  process.env.HOLDED_API_KEY_WRITE_FOOTPRINT ??= "clave-de-prueba";
  process.env.HOLDED_API_KEY_FOOTPRINT ??= "clave-de-prueba";
  process.env.HOLDED_API_KEY_WRITE_WOBA ??= "clave-de-prueba";
  process.env.HOLDED_API_KEY_WOBA ??= "clave-de-prueba";
  process.env.HOLDED_API_KEY_WRITE_EWORKS ??= "clave-de-prueba";
  process.env.HOLDED_API_KEY_EWORKS ??= "clave-de-prueba";
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? "GET") !== "GET") throw new Error(`ESCRITURA BLOQUEADA EN EL BANCO DE CASOS: ${init?.method} ${String(url)}`);
    const u = String(url);
    const coincidencia = u.match(/\/treasury\/accounts\/([^/]+)\/bank-movements/);
    const cuerpo = coincidencia
      ? { items: caso.movimientos[decodeURIComponent(coincidencia[1])] ?? [], has_more: false }
      : { items: caso.cuentas };
    return new Response(JSON.stringify(cuerpo), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try { return await prueba(); } finally { globalThis.fetch = original; }
}

export interface ResultadoBusquedaCargo {
  candidatos: Array<{ movementId: string; compatibilidad: "por_confirmar" | "aprendido" | null }>;
  vistoPorConciliacionAutomatica: string[];
  botones: string[];
}

export async function ejecutarCasoBusquedaCargo(caso: CasoBusquedaCargo): Promise<ResultadoBusquedaCargo> {
  const aprendidas: ConciliacionVerificadaAprendida[] = (caso.aprendidas ?? []).map((a, i) => ({
    rowIndex: i + 2, clave: `k${i}`, empresa: caso.empresa, proveedor: a.proveedor, moneda: a.moneda, accountId: "",
    descripcionMovimiento: a.descripcionMovimiento, ultimoMonto: caso.ticket.monto, vecesConfirmado: 1,
    primeraConfirmacionEn: "", ultimaConfirmacionEn: "", gastoIdUltimo: "", origenCoincidencia: "exacta",
  }));
  const deps = { aprendidas: async () => aprendidas };
  return conHoldedSimulado(caso, async () => {
    const base = { monto: caso.ticket.monto, fecha: caso.ticket.fecha, moneda: caso.ticket.moneda, proveedor: caso.ticket.proveedor, concepto: caso.ticket.concepto };
    const armado: MovimientoBancarioCandidato[] = await buscarMovimientoSimilar(caso.empresa, { ...base, incluirPorConfirmar: true }, undefined, deps);
    const automatico = await buscarMovimientoSimilar(caso.empresa, base, undefined, deps);
    const propuesta = {
      id: "caso", empresa: caso.empresa, proveedor: caso.ticket.proveedor, concepto: caso.ticket.concepto, monto: caso.ticket.monto,
      moneda: caso.ticket.moneda, fecha: caso.ticket.fecha, candidatos: [], lineas: [], chatId: 1, messageId: 1, creadoEn: 1,
      hayMovimientoBancario: armado.length === 1, movimientosAmbiguos: armado,
    } as unknown as PropuestaGasto;
    return {
      candidatos: armado.map((c) => ({ movementId: c.movementId, compatibilidad: c.compatibilidad ?? null })),
      vistoPorConciliacionAutomatica: automatico.map((c) => c.movementId),
      botones: construirTecladoGasto(propuesta, opcionesTecladoDesdePropuesta(propuesta)).flat().map((b) => b.text),
    };
  });
}

export async function ejecutarCasoMonedasCuentas(caso: CasoMonedasCuentas): Promise<Array<string[] | "lanza">> {
  let actual: "ok" | "error" = "ok";
  const lector = new MonedasCuentasReales(
    async () => { if (actual === "error") throw new Error("Error de la API de Holded (503)"); return caso.cuentas; },
    () => 1_000_000,
    () => {}
  );
  const resultados: Array<string[] | "lanza"> = [];
  for (const lectura of caso.lecturas) {
    actual = lectura.holded;
    try { resultados.push([...(await lector.obtener(caso.empresa))].sort()); } catch { resultados.push("lanza"); }
  }
  return resultados;
}

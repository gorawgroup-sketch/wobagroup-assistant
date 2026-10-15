import { listBankMovements, listTreasuryAccounts, type Empresa } from "../../holded/client";
import { normalizarBusqueda } from "../../gastos/reenviarPreguntaPendiente";
import type { CargoDeclarado } from "./declaracionStore";

/**
 * Paso C de la declaración de gastos sin soporte: localizar en el banco (Holded) el movimiento real de cada cargo relacionado
 * en la declaración firmada. Los cargos vienen del extracto de la tarjeta (fecha, comercio, importe), no traen ids de Holded,
 * así que se emparejan por importe exacto, moneda, fecha cercana (la fecha de cargo y la de liquidación difieren 1-2 días) y,
 * si hace falta desempatar, por el nombre del comercio en la descripción. Nunca se elige entre dos candidatos iguales: se dice.
 */
export interface MovimientoBanco {
  accountId: string; cuenta: string; movementId: string; fecha: string; descripcion: string; importe: number; moneda: string;
  estado: string; conciliado: number;
}
export type SituacionCargoBanco = "localizado" | "ya_conciliado" | "no_encontrado" | "ambiguo";
export interface CargoLocalizado { cargo: CargoDeclarado; situacion: SituacionCargoBanco; movimiento?: MovimientoBanco; detalle?: string }

export const DIAS_TOLERANCIA_FECHA = 3;
const DIA_MS = 24 * 60 * 60 * 1000;

const diasEntre = (a: string, b: string): number => Math.abs(Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / DIA_MS;
const mismoImporte = (a: number, b: number): boolean => Math.abs(Math.abs(a) - Math.abs(b)) < 0.005;
const tokens = (t: string): string[] => normalizarBusqueda(t).split(/\s+/).filter((x) => x.length >= 3);
const describeA = (lugar: string, descripcion: string): boolean => { const d = normalizarBusqueda(descripcion); return tokens(lugar).some((x) => d.includes(x)); };

/** Lógica pura: un cargo declarado contra los movimientos leídos del banco. */
export function emparejarCargo(c: CargoDeclarado, movimientos: MovimientoBanco[]): CargoLocalizado {
  const porImporte = movimientos.filter((m) => m.moneda === c.moneda && m.importe < 0 && mismoImporte(m.importe, c.valor) && diasEntre(m.fecha, c.fecha) <= DIAS_TOLERANCIA_FECHA);
  let candidatos = porImporte;
  if (candidatos.length > 1) {
    // Un cargo libre gana a uno ya conciliado con el mismo importe y fecha (el conciliado es de otro documento).
    const libres = candidatos.filter((m) => m.estado === "pending" && m.conciliado === 0);
    if (libres.length >= 1) candidatos = libres;
  }
  if (candidatos.length > 1) {
    const porNombre = candidatos.filter((m) => describeA(c.lugar, m.descripcion));
    if (porNombre.length >= 1) candidatos = porNombre;
  }
  if (candidatos.length > 1) {
    const masCercanos = Math.min(...candidatos.map((m) => diasEntre(m.fecha, c.fecha)));
    const cercanos = candidatos.filter((m) => diasEntre(m.fecha, c.fecha) === masCercanos);
    if (cercanos.length === 1) candidatos = cercanos;
  }
  if (candidatos.length === 0) return { cargo: c, situacion: "no_encontrado", detalle: `ningún cargo de ${c.valor.toFixed(2)} ${c.moneda} entre ${DIAS_TOLERANCIA_FECHA} días antes y después del ${c.fecha}` };
  if (candidatos.length > 1) return { cargo: c, situacion: "ambiguo", detalle: candidatos.map((m) => `${m.fecha} «${m.descripcion}» (${m.cuenta})`).join(" / ") };
  const m = candidatos[0];
  if (m.estado !== "pending" || m.conciliado > 0) return { cargo: c, situacion: "ya_conciliado", movimiento: m, detalle: `${m.fecha} «${m.descripcion}» ya está conciliado en Holded` };
  return { cargo: c, situacion: "localizado", movimiento: m };
}

export interface LectorBanco { movimientos(empresa: Empresa, moneda: string, desde: string, hasta: string): Promise<MovimientoBanco[]> }

async function leerMovimientosReales(empresa: Empresa, moneda: string, desde: string, hasta: string): Promise<MovimientoBanco[]> {
  const cuentas = (await listTreasuryAccounts(empresa)).filter((c) => (c.type === "bank" || c.type === "card") && c.archived !== true && (c.currency ?? "EUR").toUpperCase() === moneda);
  const salida: MovimientoBanco[] = [];
  for (const cuenta of cuentas) {
    const movs = await listBankMovements(empresa, cuenta.id, desde, hasta);
    for (const m of movs) {
      if (!m.id) continue;
      salida.push({ accountId: cuenta.id, cuenta: cuenta.name ?? cuenta.id, movementId: m.id, fecha: String(m.booking_date ?? "").slice(0, 10), descripcion: m.description ?? "",
        importe: Number(m.amount ?? 0), moneda: (m.currency ?? cuenta.currency ?? "EUR").toUpperCase(), estado: String(m.status ?? ""), conciliado: Number(m.reconciled_amount ?? 0) });
    }
  }
  return salida;
}

const sumarDias = (fecha: string, dias: number): string => new Date(Date.parse(fecha.slice(0, 10)) + dias * DIA_MS).toISOString().slice(0, 10);

/** Lee el banco una vez por moneda (ventana que cubre todos los cargos) y empareja cada cargo. */
export async function localizarMovimientosDeclarados(empresa: Empresa, cargos: CargoDeclarado[], lector: LectorBanco = { movimientos: leerMovimientosReales }): Promise<CargoLocalizado[]> {
  const porMoneda = new Map<string, MovimientoBanco[]>();
  for (const moneda of new Set(cargos.map((c) => c.moneda.toUpperCase()))) {
    const fechas = cargos.filter((c) => c.moneda.toUpperCase() === moneda).map((c) => c.fecha).sort();
    porMoneda.set(moneda, await lector.movimientos(empresa, moneda, sumarDias(fechas[0], -DIAS_TOLERANCIA_FECHA), sumarDias(fechas[fechas.length - 1], DIAS_TOLERANCIA_FECHA)));
  }
  return cargos.map((c) => emparejarCargo({ ...c, moneda: c.moneda.toUpperCase() }, porMoneda.get(c.moneda.toUpperCase()) ?? []));
}

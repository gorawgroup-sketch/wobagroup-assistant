import { listBankMovements, listTreasuryAccounts, type BankMovement, type Empresa, type TreasuryAccount } from "../client";
import { obtenerTasaCambioHistorica } from "../../utils/exchangeRate";
import { detectarTransferencias, type CuentaTransferencia, type MovimientoTransferencia, type ResultadoDeteccion } from "./deteccion";

/** Lectura de Holded para la detección de transferencias internas. Solo GET: no escribe nada. */

const numero = (v: unknown): number | undefined => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string" || !v.trim()) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export function aCuenta(c: TreasuryAccount): CuentaTransferencia {
  return {
    id: c.id,
    nombre: (c.name ?? c.id).trim(),
    tipo: String(c.type ?? ""),
    moneda: String(c.currency ?? "").toUpperCase(),
    archivada: c.archived === true,
    proveedor: typeof c.institution_name === "string" && c.institution_name ? c.institution_name : undefined,
    sincronizadaEn: typeof c.synced_at === "string" && c.synced_at ? c.synced_at : undefined,
    cuentaContable: typeof c.accounting_account_number === "string" || typeof c.accounting_account_number === "number" ? String(c.accounting_account_number) : undefined,
  };
}

/** undefined si al movimiento le falta algún dato imprescindible: no se adivina nada sobre él. */
export function aMovimiento(cuentaId: string, monedaCuenta: string, m: BankMovement): MovimientoTransferencia | undefined {
  const importe = numero(m.amount);
  const fecha = typeof m.booking_date === "string" ? m.booking_date.slice(0, 10) : "";
  if (!m.id || importe === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return undefined;
  return {
    id: m.id, cuentaId, fecha, importe,
    moneda: String(m.currency ?? monedaCuenta).toUpperCase(),
    equivalenteEur: numero(m.accounting_amount),
    descripcion: typeof m.description === "string" ? m.description : "",
    estado: String(m.status ?? ""),
    conciliado: numero(m.reconciled_amount) ?? 0,
  };
}

export interface LecturaEmpresa extends ResultadoDeteccion {
  empresa: Empresa;
  cuentas: CuentaTransferencia[];
  movimientosLeidos: number;
}

/** Descubre las cuentas por API en cada ejecución (nunca una lista fija) y detecta las operaciones internas. */
export async function detectarTransferenciasDeEmpresa(empresa: Empresa, desde: string, hasta: string, hoy: string): Promise<LecturaEmpresa> {
  const cuentas = (await listTreasuryAccounts(empresa)).map(aCuenta);
  const movimientos: MovimientoTransferencia[] = [];
  for (const cuenta of cuentas) {
    if (cuenta.archivada || cuenta.tipo !== "bank") continue;
    for (const m of await listBankMovements(empresa, cuenta.id, desde, hasta)) {
      const movimiento = aMovimiento(cuenta.id, cuenta.moneda, m);
      if (movimiento) movimientos.push(movimiento);
    }
  }
  // Las tasas del día se piden antes y se pasan ya resueltas: la detección es pura y síncrona.
  const tasas = new Map<string, number | undefined>();
  const monedas = [...new Set(movimientos.map((m) => m.moneda))];
  const fechas = [...new Set(movimientos.filter((m) => m.estado === "pending" && m.moneda !== "EUR").map((m) => m.fecha))];
  for (const fecha of fechas) for (const a of monedas) for (const b of monedas) {
    if (a === b) continue;
    tasas.set(`${fecha}:${a}:${b}`, await obtenerTasaCambioHistorica(fecha, a, b));
  }
  const resultado = detectarTransferencias(empresa, cuentas, movimientos, { hoy, tasaHistorica: (f, a, b) => tasas.get(`${f}:${a}:${b}`) });
  return { empresa, cuentas, movimientosLeidos: movimientos.length, ...resultado };
}

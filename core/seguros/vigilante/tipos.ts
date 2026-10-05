import type { Empresa } from "../../holded/client";

export const EMPRESAS_VIGILADAS: readonly Empresa[] = ["WOBA", "EWORKS", "Footprint"];

export function esEmpresaHolded(valor: string): valor is Empresa {
  return (EMPRESAS_VIGILADAS as readonly string[]).includes(valor);
}

/** Un apunte del banco tal como lo ve el vigilante (ya normalizado desde Holded). */
export interface MovimientoBanco {
  empresa: Empresa;
  cuentaId: string;
  cuenta: string;
  id: string;
  /** Día del apunte (YYYY-MM-DD) según el banco. */
  fecha: string;
  descripcion: string;
  /** Importe firmado en la divisa de la cuenta: negativo = salida de dinero. */
  importe: number;
  moneda: string;
  /** Importe firmado en EUR: el propio importe si la cuenta es en euros, el que calcula Holded si no, null si no hay. */
  importeEur: number | null;
  /** Estado de conciliación en Holded (informativo: el dinero ya se movió aunque figure «pending»). */
  estado: string;
  /** Saldo de la cuenta inmediatamente después de este apunte, según el banco (null si Holded no lo trae). */
  saldoTras: number | null;
}

/** Importe en EUR de un apunte, o null si no se puede saber (cuenta en otra divisa sin equivalente de Holded). */
export function importeEnEur(m: MovimientoBanco): number | null {
  return m.moneda === "EUR" ? m.importe : m.importeEur;
}

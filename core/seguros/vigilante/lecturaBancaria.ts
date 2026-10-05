/**
 * Lectura de SOLO LECTURA de los movimientos bancarios de las tres empresas en Holded, con cobertura honesta.
 *
 * Un fallo de Holded no es un dato (feedback de Carlos, PR #223): si una cuenta no se pudo leer entera, el
 * vigilante no puede decir «no hay pago» sobre esa empresa. Por eso se devuelve, junto a los apuntes, qué cuentas
 * fallaron y qué empresas quedaron completas; `paginarMovimientosBancarios` ya lanza error en vez de entregar una
 * lista cortada, y aquí ese error se anota sin parar el resto de la lectura.
 */
import type { BankMovement, Empresa, TreasuryAccount } from "../../holded/client";
import type { MovimientoBanco } from "./tipos";

export interface FuentesBanco {
  listTreasuryAccounts(empresa: Empresa): Promise<TreasuryAccount[]>;
  listBankMovements(empresa: Empresa, cuentaId: string, desde?: string, hasta?: string): Promise<BankMovement[]>;
}

export interface FalloLectura {
  empresa: Empresa;
  /** Nombre de la cuenta, o «(todas)» si ni siquiera se pudo listar las cuentas de la empresa. */
  cuenta: string;
  error: string;
}

export interface LecturaBancaria {
  movimientos: MovimientoBanco[];
  cuentasLeidas: number;
  fallos: FalloLectura[];
  /** Empresas cuyas cuentas se leyeron TODAS sin error: solo sobre ellas se puede afirmar que algo «no aparece». */
  empresasCompletas: Set<Empresa>;
}

function aNumero(valor: unknown): number {
  if (typeof valor === "number") return valor;
  if (typeof valor === "string") return Number(valor.replace(",", "."));
  return Number.NaN;
}

export function normalizarMovimiento(empresa: Empresa, cuenta: TreasuryAccount, m: BankMovement): MovimientoBanco | null {
  const importe = aNumero(m.amount);
  if (!m.id || !Number.isFinite(importe)) return null;
  const moneda = String(m.currency ?? cuenta.currency ?? "EUR").toUpperCase();
  let importeEur: number | null = null;
  if (moneda === "EUR") importeEur = importe;
  else if (m.accounting_amount != null && String(m.accounting_currency ?? "EUR").toUpperCase() === "EUR") {
    const eq = aNumero(m.accounting_amount);
    importeEur = Number.isFinite(eq) ? eq : null;
  }
  const saldo = aNumero(m.balance);
  return {
    empresa,
    cuentaId: cuenta.id,
    cuenta: (cuenta.name ?? cuenta.id).trim(),
    id: String(m.id),
    fecha: String(m.booking_date ?? "").slice(0, 10),
    descripcion: String(m.description ?? ""),
    importe,
    moneda,
    importeEur,
    estado: String(m.status ?? ""),
    saldoTras: Number.isFinite(saldo) ? saldo : null,
  };
}

/** Una lectura de solo lectura que falla una vez (el 05/10/2026 Holded devolvió un 403 suelto en una cuenta que ya había leído) se repite una vez. */
async function conUnReintento<T>(leer: () => Promise<T>, pausaMs: number): Promise<T> {
  try {
    return await leer();
  } catch {
    if (pausaMs > 0) await new Promise((resolver) => setTimeout(resolver, pausaMs));
    return leer();
  }
}

export async function leerMovimientosBancarios(
  empresas: readonly Empresa[],
  desde: string,
  hasta: string,
  fuentes: FuentesBanco,
  pausaReintentoMs = 1500
): Promise<LecturaBancaria> {
  const resultado: LecturaBancaria = { movimientos: [], cuentasLeidas: 0, fallos: [], empresasCompletas: new Set() };

  // Cada empresa tiene su propia clave de Holded: se leen en paralelo; dentro de una empresa, una cuenta tras otra.
  await Promise.all(
    empresas.map(async (empresa) => {
      let cuentas: TreasuryAccount[];
      try {
        cuentas = (await conUnReintento(() => fuentes.listTreasuryAccounts(empresa), pausaReintentoMs)).filter((c) => !c.archived && c.type !== "gateway");
      } catch (error) {
        resultado.fallos.push({ empresa, cuenta: "(todas)", error: error instanceof Error ? error.message : String(error) });
        return;
      }
      let completa = true;
      for (const cuenta of cuentas) {
        try {
          const crudos = await conUnReintento(() => fuentes.listBankMovements(empresa, cuenta.id, desde, hasta), pausaReintentoMs);
          resultado.cuentasLeidas++;
          for (const crudo of crudos) {
            const m = normalizarMovimiento(empresa, cuenta, crudo);
            if (m) resultado.movimientos.push(m);
          }
        } catch (error) {
          completa = false;
          resultado.fallos.push({ empresa, cuenta: (cuenta.name ?? cuenta.id).trim(), error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (completa) resultado.empresasCompletas.add(empresa);
    })
  );
  return resultado;
}

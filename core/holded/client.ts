import { formatDateLocal } from "../utils/dateFormat";

const HOLDED_API_BASE = "https://api.holded.com/api/v2";

export type Empresa = "WOBA" | "EWORKS" | "Footprint";

const ENV_VAR_POR_EMPRESA: Record<Empresa, string> = {
  WOBA: "HOLDED_API_KEY_WOBA",
  EWORKS: "HOLDED_API_KEY_EWORKS",
  Footprint: "HOLDED_API_KEY_FOOTPRINT",
};

function getApiKey(empresa: Empresa): string {
  const envVar = ENV_VAR_POR_EMPRESA[empresa];
  const key = process.env[envVar];
  if (!key) {
    throw new Error(`Falta la variable de entorno ${envVar}`);
  }
  return key;
}

async function holdedGet(empresa: Empresa, path: string, params: Record<string, string | undefined> = {}) {
  const apiKey = getApiKey(empresa);
  const url = new URL(`${HOLDED_API_BASE}${path}`);

  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Error de la API de Holded (${response.status}) para ${empresa}: ${body}`);
  }

  return response.json();
}

/**
 * Chequeo mínimo de conexión: una sola cuenta de tesorería, la llamada más
 * barata disponible que igual confirma que la API key de LECTURA todavía es
 * válida. Nunca lanza — devuelve el resultado para el panel de conexiones.
 */
export async function verificarConexionHolded(empresa: Empresa): Promise<{ ok: boolean; detalle?: string }> {
  try {
    await holdedGet(empresa, "/treasury/accounts", { limit: "1" });
    return { ok: true };
  } catch (error) {
    return { ok: false, detalle: error instanceof Error ? error.message : String(error) };
  }
}

export interface TreasuryAccount {
  id: string;
  name?: string;
  type?: "bank" | "card" | "gateway" | string;
  currency?: string;
  /** Saldo real y actualizado de la cuenta (string decimal, ej. "73.82") — confirmado en vivo contra la API real. */
  balance?: string;
  institution_name?: string;
  /** Conteo directo de Holded de movimientos sin conciliar de esta cuenta — más rápido que listar y filtrar. */
  transactions_pending_to_reconcile?: number;
  archived?: boolean;
  [key: string]: unknown;
}

export interface BankMovement {
  id?: string;
  booking_date?: string;
  description?: string;
  /** Monto en la divisa NATIVA de la cuenta (`currency`) — NO siempre EUR, ver `accounting_amount`. */
  amount?: string | number;
  currency?: string;
  /**
   * Equivalente en EUR ya calculado por Holded, presente cuando `currency`
   * no es EUR (verificado en vivo: una cuenta en USD trae `amount`+`currency:
   * "USD"` Y `accounting_amount`+`accounting_currency: "EUR"` — el segundo
   * es el que hay que comparar contra el cashflow, que siempre está en EUR).
   * En cuentas ya en EUR viene null porque no hace falta convertir.
   */
  accounting_amount?: string | number | null;
  accounting_currency?: string | null;
  /** Saldo de la cuenta INMEDIATAMENTE DESPUÉS de este movimiento (no el saldo actual de la cuenta). */
  balance?: string;
  /** "reconciled" | "forced_reconciled" | "pending" | otros — confirmado en vivo contra la API real (ver estaConciliado). */
  status?: string;
  reconciled_amount?: string;
  origin?: string;
  [key: string]: unknown;
}

/**
 * Lista las cuentas de tesorería (bancarias) configuradas para la empresa.
 */
export async function listTreasuryAccounts(empresa: Empresa): Promise<TreasuryAccount[]> {
  const data = await holdedGet(empresa, "/treasury/accounts");
  if (Array.isArray(data)) return data as TreasuryAccount[];
  if (data && Array.isArray((data as { items?: unknown }).items)) {
    return (data as { items: TreasuryAccount[] }).items;
  }
  return [];
}

/**
 * Lista los movimientos bancarios de una cuenta de tesorería en un rango de fechas.
 * Solo lectura (GET) — no hay ningún endpoint de escritura involucrado.
 */
export async function listBankMovements(
  empresa: Empresa,
  accountId: string,
  desde?: string,
  hasta?: string
): Promise<BankMovement[]> {
  const data = await holdedGet(empresa, `/treasury/accounts/${accountId}/bank-movements`, {
    start_date: desde,
    end_date: hasta,
    limit: "200",
  });

  if (Array.isArray(data)) return data as BankMovement[];
  if (data && Array.isArray((data as { items?: unknown }).items)) {
    return (data as { items: BankMovement[] }).items;
  }
  return [];
}

const MAX_CUENTAS_A_REVISAR = 10;

/**
 * Holded usa DOS estados distintos para un movimiento ya resuelto:
 * "reconciled" (matching automático de Holded) y "forced_reconciled"
 * (conciliación manual/forzada — ej. vía este mismo sistema al llamar
 * POST .../reconcile, o alguien lo hizo a mano en Holded). Verificado en
 * vivo: bug real encontrado — reconciliarMovimiento solo aceptaba
 * "reconciled" como éxito, así que un movimiento recién conciliado por el
 * propio sistema (que Holded marca "forced_reconciled") se reportaba como
 * "no pude confirmar que quedó conciliado" aunque SÍ había quedado. Mismo
 * criterio en cualquier punto del código que decida si un movimiento
 * "todavía necesita atención" — nunca comparar contra "reconciled" a solas.
 */
export function estaConciliado(status: string | undefined): boolean {
  return status === "reconciled" || status === "forced_reconciled";
}

/**
 * Cuenta movimientos bancarios sin conciliar en los últimos `dias` días, en
 * todas las cuentas activas — mismo criterio que
 * consultar_movimientos_sin_conciliar (core/tools/movimientosSinConciliar.ts),
 * factorizado aquí para no duplicar la lógica de conteo.
 */
export async function contarMovimientosSinConciliar(empresa: Empresa, dias: number): Promise<number> {
  const hasta = new Date();
  const desde = new Date(hasta.getTime() - dias * 24 * 60 * 60 * 1000);
  const desdeStr = formatDateLocal(desde);
  const hastaStr = formatDateLocal(hasta);

  const cuentas = (await listTreasuryAccounts(empresa)).filter((c) => !c.archived).slice(0, MAX_CUENTAS_A_REVISAR);

  let total = 0;
  for (const cuenta of cuentas) {
    const movimientos = await listBankMovements(empresa, cuenta.id, desdeStr, hastaStr);
    total += movimientos.filter((m) => !estaConciliado(m.status)).length;
  }

  return total;
}

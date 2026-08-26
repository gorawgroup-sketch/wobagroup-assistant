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

export interface TreasuryAccount {
  id: string;
  name?: string;
  archived?: boolean;
  [key: string]: unknown;
}

export interface BankMovement {
  id?: string;
  booking_date?: string;
  description?: string;
  amount?: string | number;
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

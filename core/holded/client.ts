import { paginarMovimientosBancarios } from "./paginarMovimientos";
import { formatDateLocal } from "../utils/dateFormat";
import { CacheLectura, type LecturaConMeta } from "../utils/readCache";
import { enteroAcotado } from "../utils/asyncTimeout";
import { mapearConConcurrencia } from "../utils/mapearConConcurrencia";
import { conReintentoLecturaHolded } from "./readRetry";

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

/**
 * GET autenticado interno para módulos de solo lectura de Holded.
 *
 * No debe exponerse como una herramienta genérica al modelo: cada consumidor
 * tiene que validar el input y devolver únicamente los campos permitidos para
 * su dominio (por ejemplo, RRHH nunca devuelve nómina ni datos personales).
 */
export async function holdedGet<T = unknown>(
  empresa: Empresa,
  path: string,
  params: Record<string, string | undefined> = {}
): Promise<T> {
  const apiKey = getApiKey(empresa);
  const url = new URL(`${HOLDED_API_BASE}${path}`);

  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }

  return conReintentoLecturaHolded(async () => {
    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw Object.assign(
        new Error(`Error de la API de Holded (${response.status}) para ${empresa}: ${body}`),
        { status: response.status }
      );
    }

    return response.json() as Promise<T>;
  }, {
    alReintentar: ({ intento, status, demoraMs }) =>
      console.warn(`[holded/read-retry] ${empresa} GET ${url.pathname}: intento ${intento} falló (${status ?? "red"}); reintento en ${demoraMs} ms.`),
  });
}

// ---------------------------------------------------------------------------
// Proyectos de Holded (SOLO LECTURA). Todo lo de este bloque son GET: no hay
// ninguna escritura de proyectos en el sistema.
// ---------------------------------------------------------------------------

export interface HoldedProject {
  id: string;
  name: string;
  description?: string;
  contact_id?: string | null;
  contact_name?: string;
  start_date?: string | null;
  due_date?: string | null;
  tags?: string[];
  archived?: boolean;
  /** Holded devuelve hoy un entero, aunque el filtro de listado use nombres de estado. */
  status?: number;
  number_of_tasks?: number;
  completed_tasks?: number;
  billable?: boolean;
  scope?: string;
  [key: string]: unknown;
}

export interface HoldedProjectSummary {
  name?: string;
  desc?: string;
  projectEvolution?: {
    tasks?: { total?: number; completed?: number };
    dueDate?: number | string | null;
  };
  profitability?: {
    sales?: number;
    expenses?: { documents?: number; personnel?: number; total?: number };
    profit?: number;
  };
  economicStatus?: {
    sales?: number;
    quoted?: number;
    difference?: number;
    estimatePrice?: number;
    billed?: number;
    collected?: number;
    remaining?: number;
  };
  [key: string]: unknown;
}

const CACHE_PROYECTOS_TTL_MS = 5 * 60 * 1000;
/** Tope de páginas (100 por página). Si se supera, el catálogo sería incompleto y se falla en vez de ocultarlo. */
const MAX_PAGINAS_PROYECTOS = 50;
const cachesProyectos = new Map<Empresa, CacheLectura<HoldedProject[]>>();

function cacheProyectosDe(empresa: Empresa): CacheLectura<HoldedProject[]> {
  let cache = cachesProyectos.get(empresa);
  if (!cache) {
    cache = new CacheLectura<HoldedProject[]>("holded_proyectos", CACHE_PROYECTOS_TTL_MS);
    cachesProyectos.set(empresa, cache);
  }
  return cache;
}

function normalizarNombreProyecto(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

async function cargarProyectos(empresa: Empresa): Promise<HoldedProject[]> {
  const projects: HoldedProject[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGINAS_PROYECTOS; page++) {
    const data = await holdedGet<{ items?: HoldedProject[]; has_more?: boolean; cursor?: string | null }>(
      empresa,
      "/projects",
      { limit: "100", cursor }
    );
    projects.push(...(Array.isArray(data?.items) ? data.items : []));
    if (!data?.has_more || !data.cursor) return projects;
    cursor = data.cursor;
  }
  throw new Error(`El catálogo de proyectos de ${empresa} supera ${MAX_PAGINAS_PROYECTOS} páginas; no se devuelve incompleto.`);
}

/**
 * Lista el catálogo que la API key de la empresa puede ver. Es importante
 * no confundirlo con todo lo que ve un usuario en la web: los proyectos
 * privados de un usuario no aparecen para una API key de organización.
 * Un fallo de Holded se propaga: nunca se convierte en «no hay proyectos».
 */
export async function listProjects(empresa: Empresa, forceRefresh = false): Promise<HoldedProject[]> {
  const cache = cacheProyectosDe(empresa);
  if (forceRefresh) cache.invalidar();
  return (await cache.obtener(() => cargarProyectos(empresa))).datos;
}

/** Obtiene los importes agregados de un proyecto. Siempre es una consulta GET. */
export async function getProjectSummary(empresa: Empresa, projectId: string): Promise<HoldedProjectSummary> {
  return holdedGet<HoldedProjectSummary>(empresa, `/projects/${encodeURIComponent(projectId)}/summary`);
}

export interface ProjectMatch {
  exact?: HoldedProject;
  candidates: HoldedProject[];
}

/**
 * Resuelve por id o nombre exacto normalizado. Los candidatos parciales se
 * devuelven solo para explicar/preguntar; jamás autorizan una imputación.
 */
export function matchProject(projects: HoldedProject[], query: string, includeArchived = false): ProjectMatch {
  const available = includeArchived ? projects : projects.filter((project) => !project.archived);
  const trimmed = query.trim();
  const normalized = normalizarNombreProyecto(trimmed);
  if (!trimmed) return { candidates: available };

  const idMatch = available.find((project) => project.id === trimmed);
  if (idMatch) return { exact: idMatch, candidates: [idMatch] };

  const exactByName = available.filter((project) => normalizarNombreProyecto(project.name) === normalized);
  if (exactByName.length === 1) return { exact: exactByName[0], candidates: exactByName };
  if (exactByName.length > 1) return { candidates: exactByName };

  const partial = available.filter((project) => {
    const name = normalizarNombreProyecto(project.name);
    // Ambas direcciones exigen >= 3 caracteres: un proyecto llamado «A» no debe casar con cualquier consulta.
    return normalized.length >= 3 && name.length >= 3 && (name.includes(normalized) || normalized.includes(name));
  });
  return { candidates: partial };
}

/**
 * Variante deliberadamente estricta para escrituras contables: solo acepta
 * una coincidencia única por id o nombre exacto, nunca una aproximación.
 */
export async function resolveProjectExact(
  empresa: Empresa,
  query: string,
  forceRefresh = false
): Promise<ProjectMatch> {
  return matchProject(await listProjects(empresa, forceRefresh), query, false);
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
async function cargarCuentasTesoreria(empresa: Empresa): Promise<TreasuryAccount[]> {
  const data = await holdedGet(empresa, "/treasury/accounts");
  if (Array.isArray(data)) return data as TreasuryAccount[];
  if (data && Array.isArray((data as { items?: unknown }).items)) {
    return (data as { items: TreasuryAccount[] }).items;
  }
  return [];
}

const CACHE_CUENTAS_TTL_MS = enteroAcotado(process.env.WOBI_HOLDED_CACHE_TTL_MS, 10_000, 0, 60_000);
const cachesCuentas = new Map<Empresa, CacheLectura<TreasuryAccount[]>>();

function cacheCuentasDe(empresa: Empresa): CacheLectura<TreasuryAccount[]> {
  let cache = cachesCuentas.get(empresa);
  if (!cache) {
    cache = new CacheLectura<TreasuryAccount[]>("holded_cuentas", CACHE_CUENTAS_TTL_MS);
    cachesCuentas.set(empresa, cache);
  }
  return cache;
}

export function listTreasuryAccountsConMeta(empresa: Empresa): Promise<LecturaConMeta<TreasuryAccount[]>> {
  return cacheCuentasDe(empresa).obtener(() => cargarCuentasTesoreria(empresa));
}

export async function listTreasuryAccounts(empresa: Empresa): Promise<TreasuryAccount[]> {
  return (await listTreasuryAccountsConMeta(empresa)).datos;
}

export function invalidarCacheCuentasTesoreria(empresa?: Empresa): void {
  if (empresa) cachesCuentas.get(empresa)?.invalidar();
  else for (const cache of cachesCuentas.values()) cache.invalidar();
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
  // Todas las páginas del rango (ver paginarMovimientos.ts): una sola página dejaba fuera los movimientos más antiguos.
  return paginarMovimientosBancarios<BankMovement>(
    (parametros) => holdedGet(empresa, `/treasury/accounts/${accountId}/bank-movements`, parametros),
    { start_date: desde, end_date: hasta }
  );
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

  // Cuentas en paralelo (acotado): en serie eran ~5 s por empresa dentro de cada lectura del panel /cerebro.
  const porCuenta = await mapearConConcurrencia(cuentas, 3, async (cuenta) => {
    const movimientos = await listBankMovements(empresa, cuenta.id, desdeStr, hastaStr);
    return movimientos.filter((m) => !estaConciliado(m.status)).length;
  });

  return porCuenta.reduce((total, n) => total + n, 0);
}

/**
 * Los importes de /treasury/.../bank-movements vienen en formato decimal normal ("-3.77"), NO en
 * formato ES como /purchases (ver el mismo hallazgo, ya documentado, en core/holded/write.ts —
 * duplicado acá para no crear un ciclo write.ts -> client.ts -> write.ts).
 */
function parsearMontoMovimientoCliente(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

export interface SaldoHistoricoCuenta {
  balance: number;
  /** Fecha real (YYYY-MM-DD) del último movimiento encontrado en o antes de la fecha pedida — puede
   *  ser anterior a la fecha pedida si la cuenta no tuvo movimientos justo esos días. */
  fechaMovimiento: string;
}

/**
 * Pedido explícito de Carlos (2026-09-17, caso real: saldo de WOBA/EWORKS al domingo 13 de
 * septiembre): la herramienta de saldos solo daba el saldo de HOY — Holded no expone un endpoint de
 * "saldo a fecha pasada", pero cada movimiento bancario SÍ trae el saldo de la cuenta inmediatamente
 * DESPUÉS de ese movimiento (BankMovement.balance, ver arriba — ya confirmado en vivo contra la API
 * real). Reconstruir sumando movimientos a mano sería frágil (un movimiento no capturado desalinea
 * todo lo posterior); en cambio, basta encontrar el ÚLTIMO movimiento en o antes de la fecha pedida y
 * leer su balance directamente — ese es, por definición, el saldo real de la cuenta al cierre de esa
 * fecha (si no hubo movimientos después de ese día hasta la fecha pedida, el saldo no cambió).
 *
 * Se ordena explícitamente por fecha (nunca se confía en el orden del array que devuelve Holded, aun
 * habiéndolo verificado en vivo una vez — el orden no está documentado) y se amplía la ventana de
 * búsqueda hacia atrás si la cuenta no tuvo movimientos en la ventana inicial (cuentas con poca
 * actividad), hasta un límite razonable antes de rendirse.
 */
export async function obtenerSaldoHistoricoCuenta(
  empresa: Empresa,
  accountId: string,
  fecha: string
): Promise<SaldoHistoricoCuenta | undefined> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    throw new Error("La fecha debe usar el formato YYYY-MM-DD.");
  }
  const objetivo = new Date(`${fecha}T00:00:00Z`);
  if (Number.isNaN(objetivo.getTime())) {
    throw new Error("Fecha inválida.");
  }

  const VENTANAS_DIAS = [60, 180, 365, 730];
  for (const dias of VENTANAS_DIAS) {
    const desde = new Date(objetivo.getTime() - dias * 24 * 60 * 60 * 1000);
    const movimientos = await listBankMovements(empresa, accountId, formatDateLocal(desde), fecha);
    if (movimientos.length === 0) continue;

    // Sort estable por fecha descendente — con empate (varios movimientos el mismo día), Array.sort
    // en JS moderno conserva el orden relativo original entre elementos empatados, que ya se
    // confirmó en vivo que refleja el orden real de aplicación de Holded para ese mismo día.
    const ordenados = [...movimientos].sort((a, b) => (b.booking_date ?? "").localeCompare(a.booking_date ?? ""));
    const conBalanceValido = ordenados.find((m) => Number.isFinite(parsearMontoMovimientoCliente(m.balance)));
    if (!conBalanceValido) continue;

    return {
      balance: parsearMontoMovimientoCliente(conBalanceValido.balance),
      fechaMovimiento: (conBalanceValido.booking_date ?? fecha).slice(0, 10),
    };
  }

  return undefined;
}

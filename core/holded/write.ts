import { readFile } from "node:fs/promises";
import type { Empresa } from "./client";
import { formatDateLocal } from "../utils/dateFormat";

const HOLDED_API_BASE = "https://api.holded.com/api/v2";

/**
 * Cliente de escritura de Holded, separado del de solo lectura (client.ts):
 * usa una API key distinta (HOLDED_API_KEY_WRITE_*), generada con permiso
 * de escritura acotado al módulo de Contabilidad/Compras — la key de
 * lectura no tiene ese permiso a propósito (principio de menor privilegio,
 * mismo patrón que los clientes de Google separados por lectura/escritura).
 *
 * Verificado en vivo antes de construir sobre esto: el endpoint real para
 * crear un gasto es POST /api/v2/purchases (no /invoicing/v1/documents/...
 * como sugiere documentación de terceros desactualizada — ese endpoint
 * devuelve "Invalid key" sin importar la key usada).
 */
const ENV_VAR_WRITE_POR_EMPRESA: Record<Empresa, string> = {
  WOBA: "HOLDED_API_KEY_WRITE_WOBA",
  EWORKS: "HOLDED_API_KEY_WRITE_EWORKS",
  // La key de Footprint (a diferencia de WOBA/EWORKS) vino con permiso de
  // lectura Y escritura en una sola credencial — se reutiliza el mismo
  // valor para ambos roles (HOLDED_API_KEY_FOOTPRINT en client.ts), pero el
  // código mantiene la separación read/write de todas formas.
  Footprint: "HOLDED_API_KEY_WRITE_FOOTPRINT",
};

function getWriteApiKey(empresa: Empresa): string {
  const envVar = ENV_VAR_WRITE_POR_EMPRESA[empresa];
  const key = process.env[envVar];
  if (!key) {
    throw new Error(`Falta la variable de entorno ${envVar}`);
  }
  return key;
}

async function holdedWriteCall(
  empresa: Empresa,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<unknown> {
  const apiKey = getWriteApiKey(empresa);

  const response = await fetch(`${HOLDED_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Error de la API de Holded (${response.status}) para ${empresa}: ${errBody}`);
  }

  return response.json();
}

interface HoldedContact {
  id: string;
  name?: string;
  [key: string]: unknown;
}

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(new RegExp("[̀-ͯ]", "g"), "")
    .toLowerCase();
}

const MAX_PAGINAS_CONTACTOS = 20;

/**
 * Busca un contacto de Holded por nombre (coincidencia parcial, insensible a
 * mayúsculas/acentos). La API de Holded no soporta filtrar por nombre en el
 * servidor (el parámetro `name` no filtra), así que se pagina y se filtra
 * localmente — igual que la búsqueda de archivos en Drive. Nunca inventa un
 * contact_id: si no encuentra coincidencia, devuelve undefined.
 */
export async function buscarContactoHolded(empresa: Empresa, nombre: string): Promise<HoldedContact | undefined> {
  const objetivo = normalizar(nombre);
  let cursor: string | undefined;

  for (let pagina = 0; pagina < MAX_PAGINAS_CONTACTOS; pagina++) {
    const path = `/contacts?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const data = (await holdedWriteCall(empresa, "GET", path)) as {
      items?: HoldedContact[];
      cursor?: string;
      has_more?: boolean;
    };

    const match = (data.items ?? []).find((c) => typeof c.name === "string" && normalizar(c.name).includes(objetivo));
    if (match) return match;

    if (!data.has_more || !data.cursor) break;
    cursor = data.cursor;
  }

  return undefined;
}

export interface PurchaseCandidato {
  id: string;
  contactName: string;
  fecha: string;
  total: number;
  descripcion: string;
}

/** Los importes de /purchases vienen como string en formato ES ("1.234,56"). */
function parsearMontoHolded(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return NaN;
  const normalizado = raw.replace(/\./g, "").replace(",", ".");
  const n = Number(normalizado);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Los importes de /treasury/.../bank-movements vienen en formato decimal
 * normal ("-3.77"), NO en formato ES como /purchases — verificado en vivo
 * (bug encontrado: usar parsearMontoHolded aquí convertía "-3.77" en -377,
 * porque interpretaba el punto como separador de miles). No confundir los
 * dos parsers aunque ambos "parseen un monto de Holded".
 */
function parsearMontoMovimiento(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

const TOLERANCIA_MONTO = 0.01;
const VENTANA_DIAS_BUSQUEDA = 10;
const MAX_PAGINAS_PURCHASES = 10;

/**
 * Busca gastos YA existentes en Holded que podrían corresponder a una
 * factura entrante — mismo proveedor (coincidencia parcial), monto dentro de
 * ±0.01, y fecha dentro de una ventana de ±10 días. Nunca decide un match
 * "aceptable" por sí sola: devuelve TODOS los candidatos razonables para que
 * el usuario confirme cuál es (o ninguno, si no hay), igual que
 * buscarContactoHolded nunca inventa un contact_id.
 */
export async function buscarGastoSimilar(
  empresa: Empresa,
  criterios: { proveedor: string; monto: number; fecha: string }
): Promise<PurchaseCandidato[]> {
  const objetivo = normalizar(criterios.proveedor);
  const fechaBase = new Date(criterios.fecha);

  const desde = new Date(fechaBase);
  desde.setDate(desde.getDate() - VENTANA_DIAS_BUSQUEDA);
  const hasta = new Date(fechaBase);
  hasta.setDate(hasta.getDate() + VENTANA_DIAS_BUSQUEDA);

  const candidatos: PurchaseCandidato[] = [];
  let cursor: string | undefined;

  for (let pagina = 0; pagina < MAX_PAGINAS_PURCHASES; pagina++) {
    const params = new URLSearchParams({
      limit: "100",
      start_date: formatDateLocal(desde),
      end_date: formatDateLocal(hasta),
    });
    if (cursor) params.set("cursor", cursor);

    const data = (await holdedWriteCall(empresa, "GET", `/purchases?${params.toString()}`)) as {
      items?: Array<{ id: string; contact_name?: string; date?: string; total?: string; description?: string }>;
      cursor?: string;
      has_more?: boolean;
    };

    for (const item of data.items ?? []) {
      if (!item.contact_name || !normalizar(item.contact_name).includes(objetivo)) continue;
      const total = parsearMontoHolded(item.total);
      if (!Number.isFinite(total) || Math.abs(total - criterios.monto) > TOLERANCIA_MONTO) continue;

      candidatos.push({
        id: item.id,
        contactName: item.contact_name,
        fecha: item.date ?? "",
        total,
        descripcion: item.description ?? "",
      });
    }

    if (!data.has_more || !data.cursor) break;
    cursor = data.cursor;
  }

  return candidatos;
}

export interface GastoSinComprobante {
  id: string;
  contactName: string;
  total: number;
  fecha: string;
  descripcion: string;
  tags: string[];
}

const MAX_GASTOS_A_REVISAR = 150;

/**
 * Busca gastos en un rango de fechas que NO tienen ningún comprobante
 * adjunto en Holded (GET /purchases/{id}/attachments vacío). Verificado en
 * vivo contra datos reales: de 60 gastos de WOBA, 59 tenían adjunto y 1 no
 * — el mecanismo (list + N llamadas a /attachments) funciona y distingue
 * ambos casos correctamente. Si `tags` trae el nombre de una persona (ej.
 * "proyectosimon"), es la única pista disponible de quién debe el
 * comprobante — la mayoría de los gastos no traen esa etiqueta.
 */
export async function buscarGastosSinComprobante(
  empresa: Empresa,
  desde: string,
  hasta: string
): Promise<{ sinComprobante: GastoSinComprobante[]; totalRevisados: number; limiteAlcanzado: boolean }> {
  const revisados: Array<{ id: string; contact_name?: string; date?: string; total?: string; description?: string; tags?: string[] }> = [];
  let cursor: string | undefined;
  let limiteAlcanzado = false;

  while (revisados.length < MAX_GASTOS_A_REVISAR) {
    const params = new URLSearchParams({ limit: "100", start_date: desde, end_date: hasta });
    if (cursor) params.set("cursor", cursor);

    const data = (await holdedWriteCall(empresa, "GET", `/purchases?${params.toString()}`)) as {
      items?: Array<{ id: string; contact_name?: string; date?: string; total?: string; description?: string; tags?: string[] }>;
      cursor?: string;
      has_more?: boolean;
    };

    for (const item of data.items ?? []) {
      if (revisados.length >= MAX_GASTOS_A_REVISAR) {
        limiteAlcanzado = true;
        break;
      }
      revisados.push(item);
    }

    if (limiteAlcanzado || !data.has_more || !data.cursor) break;
    cursor = data.cursor;
  }

  const sinComprobante: GastoSinComprobante[] = [];

  for (const item of revisados) {
    const attachments = (await holdedWriteCall(empresa, "GET", `/purchases/${item.id}/attachments`)) as {
      items?: unknown[];
    };
    if ((attachments.items ?? []).length === 0) {
      sinComprobante.push({
        id: item.id,
        contactName: item.contact_name ?? "(sin proveedor)",
        total: parsearMontoHolded(item.total),
        fecha: item.date ?? "",
        descripcion: item.description ?? "",
        tags: item.tags ?? [],
      });
    }
  }

  return { sinComprobante, totalRevisados: revisados.length, limiteAlcanzado };
}

/**
 * Adjunta un comprobante (PDF/imagen) a un gasto ya existente en Holded
 * (POST /purchases/{id}/attachments, multipart). Verificado en vivo: un
 * cuerpo JSON vacío devuelve "File not found", confirmando que este
 * endpoint espera un archivo real, no JSON.
 */
export async function adjuntarComprobanteHolded(empresa: Empresa, purchaseId: string, rutaLocal: string, nombreArchivo: string, mimeType: string | undefined): Promise<void> {
  const apiKey = getWriteApiKey(empresa);
  const bytes = await readFile(rutaLocal);

  const formData = new FormData();
  formData.append("file", new Blob([bytes], { type: mimeType || "application/octet-stream" }), nombreArchivo);

  const response = await fetch(`${HOLDED_API_BASE}/purchases/${purchaseId}/attachments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Error adjuntando comprobante en Holded (${response.status}) para ${empresa}: ${errBody}`);
  }
}

export interface TaxCatalogEntry {
  key: string;
  amount: number;
}

const catalogoImpuestosCache = new Map<Empresa, TaxCatalogEntry[]>();

/**
 * Catálogo real de códigos de impuesto de Holded (GET /taxes, filtrado a
 * compras). Se consulta en vez de adivinar un código — verificado en vivo
 * que mandar el key real (ej. "p_iva_21") calcula correctamente el IVA de
 * la línea (probado: 10€ base + p_iva_21 → tax 2,10€, total 12,10€).
 * Cacheado en memoria por empresa (el catálogo no cambia en caliente).
 */
export async function obtenerCatalogoImpuestos(empresa: Empresa): Promise<TaxCatalogEntry[]> {
  const cached = catalogoImpuestosCache.get(empresa);
  if (cached) return cached;

  const data = (await holdedWriteCall(empresa, "GET", "/taxes")) as {
    items?: Array<{ key?: string; amount?: string | number; scope?: string; type?: string }>;
  };

  const catalogo = (data.items ?? [])
    .filter((t) => t.scope === "purchases" && t.type !== "group" && t.key)
    .map((t) => ({ key: t.key as string, amount: Number(t.amount) || 0 }));

  catalogoImpuestosCache.set(empresa, catalogo);
  return catalogo;
}

/**
 * Mapea un porcentaje de IVA (leído de una factura, ej. 21 o 7.5) al código
 * real más plausible del catálogo — prefiere el código "plano" p_iva_XX
 * (el caso normal) y si no existe, cualquier código con ese mismo
 * porcentaje. Nunca inventa un key que no esté en el catálogo real; si no
 * encuentra nada, devuelve undefined (la línea queda sin taxes, 0% neto).
 */
export function mapearPorcentajeATaxKey(catalogo: TaxCatalogEntry[], pct: number): string | undefined {
  const claveDirecta = `p_iva_${String(pct).replace(".", "")}`;
  const directo = catalogo.find((t) => t.key === claveDirecta);
  if (directo) return directo.key;

  return catalogo.find((t) => t.amount === pct)?.key;
}

export interface LineaGastoHolded {
  concepto: string;
  base: number;
  tipoIvaPct: number;
}

export interface NuevoGastoHolded {
  contactId: string;
  fecha: string; // YYYY-MM-DD
  descripcion: string;
  lineas: LineaGastoHolded[];
}

/**
 * Crea un documento de gasto/compra en Holded (POST /v2/purchases), con el
 * desglose de IVA real por línea. Solo debe invocarse tras aprobación
 * explícita del usuario por botón — nunca automáticamente. Queda como
 * borrador/pendiente en Holded (no contabilizado en firme), tal como se
 * comportó en la prueba en vivo.
 */
export async function crearGastoHolded(empresa: Empresa, gasto: NuevoGastoHolded): Promise<{ id: string }> {
  const catalogo = await obtenerCatalogoImpuestos(empresa);

  const items = gasto.lineas.map((linea) => {
    const taxKey = mapearPorcentajeATaxKey(catalogo, linea.tipoIvaPct);
    return {
      name: linea.concepto || gasto.descripcion,
      units: 1,
      price: linea.base,
      tax: 0,
      taxes: taxKey ? [taxKey] : [],
    };
  });

  const data = (await holdedWriteCall(empresa, "POST", "/purchases", {
    contact_id: gasto.contactId,
    date: gasto.fecha,
    description: gasto.descripcion,
    items,
  })) as { id?: string };

  if (!data.id) {
    throw new Error("Holded no devolvió un id para el gasto creado.");
  }

  return { id: data.id };
}

export interface MovimientoBancarioCandidato {
  accountId: string;
  movementId: string;
  descripcion: string;
  monto: number;
  fecha: string;
}

const VENTANA_DIAS_MOVIMIENTO = 5;

/**
 * Busca movimientos bancarios SIN conciliar (status != "reconciled") en
 * todas las cuentas activas de la empresa, con monto (en valor absoluto) y
 * fecha cercanos a los dados. Se usa solo para el auto-conciliar tras crear
 * o adjuntar un gasto propio — nunca para crear gastos a partir de
 * movimientos huérfanos (eso queda para revisión humana, ver
 * consultar_movimientos_sin_conciliar).
 */
export async function buscarMovimientoSimilar(
  empresa: Empresa,
  criterios: { monto: number; fecha: string }
): Promise<MovimientoBancarioCandidato[]> {
  const fechaBase = new Date(criterios.fecha);
  const desde = new Date(fechaBase);
  desde.setDate(desde.getDate() - VENTANA_DIAS_MOVIMIENTO);
  const hasta = new Date(fechaBase);
  hasta.setDate(hasta.getDate() + VENTANA_DIAS_MOVIMIENTO);

  const cuentasData = (await holdedWriteCall(empresa, "GET", "/treasury/accounts")) as {
    items?: Array<{ id: string; archived?: boolean }>;
  };
  const cuentas = (cuentasData.items ?? []).filter((c) => !c.archived);

  const candidatos: MovimientoBancarioCandidato[] = [];

  for (const cuenta of cuentas) {
    const params = new URLSearchParams({
      start_date: formatDateLocal(desde),
      end_date: formatDateLocal(hasta),
      limit: "100",
    });
    const data = (await holdedWriteCall(
      empresa,
      "GET",
      `/treasury/accounts/${cuenta.id}/bank-movements?${params.toString()}`
    )) as {
      items?: Array<{ id: string; description?: string; amount?: string | number; booking_date?: string; status?: string }>;
    };

    for (const mov of data.items ?? []) {
      if (mov.status === "reconciled") continue;
      const monto = parsearMontoMovimiento(mov.amount);
      if (!Number.isFinite(monto) || Math.abs(Math.abs(monto) - Math.abs(criterios.monto)) > TOLERANCIA_MONTO) continue;

      candidatos.push({
        accountId: cuenta.id,
        movementId: mov.id,
        descripcion: mov.description ?? "",
        monto,
        fecha: mov.booking_date ? mov.booking_date.slice(0, 10) : "",
      });
    }
  }

  return candidatos;
}

/**
 * Intenta conciliar un movimiento bancario contra el gasto que se le
 * asocia (POST .../reconcile). El body de este endpoint no está bien
 * documentado — probado en vivo con varios cuerpos contra un movimiento ya
 * conciliado, todos devuelven 200/null sin poder confirmar el efecto real.
 * Por eso esta función SIEMPRE relee el movimiento después de llamarlo y
 * solo reporta éxito si `status` realmente pasó a "reconciled" — nunca
 * confía en el 200 por sí solo.
 */
export async function reconciliarMovimiento(
  empresa: Empresa,
  accountId: string,
  movementId: string,
  fechaAproximada: string
): Promise<{ ok: boolean; statusFinal: string }> {
  await holdedWriteCall(empresa, "POST", `/treasury/accounts/${accountId}/bank-movements/${movementId}/reconcile`, {});

  // La API no tiene un GET por id individual de movimiento documentado —
  // se relee acotando por fecha (misma ventana que la búsqueda) y se busca
  // el id dentro de esos resultados.
  const fechaBase = new Date(fechaAproximada);
  const desde = new Date(fechaBase);
  desde.setDate(desde.getDate() - VENTANA_DIAS_MOVIMIENTO);
  const hasta = new Date(fechaBase);
  hasta.setDate(hasta.getDate() + VENTANA_DIAS_MOVIMIENTO);

  const params = new URLSearchParams({
    start_date: formatDateLocal(desde),
    end_date: formatDateLocal(hasta),
    limit: "100",
  });
  const verificacion = (await holdedWriteCall(
    empresa,
    "GET",
    `/treasury/accounts/${accountId}/bank-movements?${params.toString()}`
  )) as { items?: Array<{ id: string; status?: string }> };

  const movimiento = (verificacion.items ?? []).find((m) => m.id === movementId);
  const statusFinal = movimiento?.status ?? "(no encontrado al releer)";

  return { ok: statusFinal === "reconciled", statusFinal };
}

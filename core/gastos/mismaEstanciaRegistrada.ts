import type { Empresa } from "../holded/client";
import { holdedGet } from "../holded/client";
import { obtenerCompraHoldedPorId } from "../holded/write";
import { listarRegistrosGastoPorEmpresa } from "./gastoPorCorreoStore";
import { mapearConConcurrencia } from "../utils/mapearConConcurrencia";
import { esHospedaje, esMismaEstancia, type EstanciaGasto } from "./mismaEstancia";

export interface EstanciaRegistrada { gastoId: string; proveedor: string; monto: number; moneda: string; fecha: string }

const VENTANA_DIAS = 45;
const MAX_LECTURAS_POR_ID = 40;
const RECIENTE_MS = 90 * 24 * 60 * 60_000;

/** Lo leído por id se recuerda 30 min (también los borrados): varias propuestas seguidas no repiten las mismas lecturas de Holded. */
type LecturaGasto = { concepto?: string; proveedor?: string; monto?: number; moneda?: string; fecha?: string } | null;
const CACHE_LECTURAS_MS = 30 * 60_000;
const cacheLecturas = new Map<string, { hasta: number; lectura: LecturaGasto }>();

function montoHolded(raw: unknown): number {
  if (typeof raw === "number") return raw;
  const n = Number(String(raw ?? "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Gastos de hospedaje ya registrados que son la MISMA estancia que `actual` (ver mismaEstancia.ts). Dos fuentes:
 *  1. El registro de gastos creados desde correo: los tickets que Holded oculta de /purchases solo se encuentran por su id. Las filas
 *     antiguas no guardaron concepto ni importe; las recientes sin esos datos se leen por id en Holded (con tope).
 *  2. El listado de compras de Holded en una ventana de ±45 días alrededor de la fecha del documento (descripción «Hospedaje …»).
 * Solo sirve para AVISAR en la propuesta. Los errores de lectura se propagan: quien llama decide omitir el aviso.
 */
export async function buscarMismaEstanciaRegistrada(
  empresa: Empresa,
  actual: EstanciaGasto,
  opciones: { fecha?: string; excluirMensajeIdGmail?: string; excluirGastoIds?: readonly string[] }
): Promise<EstanciaRegistrada[]> {
  // Solo los hospedajes tienen «misma estancia»: para cualquier otro gasto no se lee nada (antes cada propuesta pagaba hasta 40 lecturas de Holded).
  if (!actual.concepto || !esHospedaje(actual.concepto)) return [];
  const encontrados = new Map<string, EstanciaRegistrada>();
  const excluidos = new Set(opciones.excluirGastoIds ?? []);
  const anotar = (gastoId: string, e: { concepto?: string; proveedor?: string; monto?: number; moneda?: string; fecha?: string }) => {
    if (encontrados.has(gastoId) || excluidos.has(gastoId) || !esMismaEstancia(actual, { concepto: e.concepto, monto: e.monto, moneda: e.moneda })) return;
    encontrados.set(gastoId, { gastoId, proveedor: e.proveedor ?? "?", monto: e.monto ?? NaN, moneda: e.moneda ?? "", fecha: e.fecha ?? "" });
  };

  const ahora = Date.now();
  const porLeer: string[] = [];
  for (const registro of await listarRegistrosGastoPorEmpresa(empresa)) {
    if (opciones.excluirMensajeIdGmail && registro.mensajeIdGmail === opciones.excluirMensajeIdGmail) continue;
    const i = registro.identidad;
    if (i?.concepto && i.monto !== undefined) { anotar(registro.gastoId, i); continue; }
    if (ahora - registro.creadoEn > RECIENTE_MS) continue;
    const guardada = cacheLecturas.get(`${empresa}:${registro.gastoId}`);
    if (guardada && guardada.hasta > ahora) {
      if (guardada.lectura) anotar(registro.gastoId, guardada.lectura);
      continue;
    }
    if (porLeer.length < MAX_LECTURAS_POR_ID) porLeer.push(registro.gastoId);
  }
  // Las filas antiguas sin concepto ni importe se leen por id en Holded, en paralelo y con tope.
  const lecturas = await mapearConConcurrencia(porLeer, 8, async (gastoId) => {
    try {
      const compra = (await obtenerCompraHoldedPorId(empresa, gastoId)) as Record<string, unknown>;
      const lectura: LecturaGasto = {
        concepto: String(compra.description ?? ""), proveedor: String(compra.contact_name ?? ""),
        monto: montoHolded(compra.total), moneda: String(compra.currency ?? "").toUpperCase(), fecha: String(compra.date ?? "").slice(0, 10),
      };
      return { gastoId, lectura };
    } catch (error) {
      // Un gasto del registro que ya no existe en Holded (borrado a mano) no puede abortar la comprobación de los demás.
      console.warn(`[mismaEstanciaRegistrada] No se pudo leer el gasto ${gastoId} del registro; se omite:`, error instanceof Error ? error.message.slice(0, 120) : error);
      return { gastoId, lectura: null as LecturaGasto };
    }
  });
  for (const { gastoId, lectura } of lecturas) {
    cacheLecturas.set(`${empresa}:${gastoId}`, { hasta: ahora + CACHE_LECTURAS_MS, lectura });
    if (lectura) anotar(gastoId, lectura);
  }

  const base = opciones.fecha && /^\d{4}-\d{2}-\d{2}/.test(opciones.fecha) ? new Date(opciones.fecha.slice(0, 10)) : new Date();
  const desde = new Date(base.getTime() - VENTANA_DIAS * 86_400_000).toISOString().slice(0, 10);
  const hasta = new Date(base.getTime() + VENTANA_DIAS * 86_400_000).toISOString().slice(0, 10);
  let cursor: string | undefined;
  for (let pagina = 0; pagina < 5; pagina++) {
    const params = new URLSearchParams({ limit: "100", start_date: desde, end_date: hasta });
    if (cursor) params.set("cursor", cursor);
    const d = (await holdedGet(empresa, `/purchases?${params}`)) as { items?: Array<Record<string, unknown>>; cursor?: string; has_more?: boolean };
    for (const it of d.items ?? []) {
      if (typeof it.description !== "string" || !/^\s*(hospedaje|alojamiento)/i.test(it.description)) continue;
      anotar(String(it.id), {
        concepto: it.description, proveedor: String(it.contact_name ?? ""), monto: montoHolded(it.total),
        moneda: String(it.currency ?? "").toUpperCase(), fecha: String(it.date ?? "").slice(0, 10),
      });
    }
    if (!d.has_more || !d.cursor) break;
    cursor = d.cursor;
  }
  return [...encontrados.values()];
}

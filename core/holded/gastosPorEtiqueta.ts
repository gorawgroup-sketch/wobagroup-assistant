import { holdedGet, listTreasuryAccounts, type Empresa } from "./client";
import { durablePurchaseStore } from "./durablePurchaseStore";
import { listarGastoIdsAsignados } from "./asignacionCuentaLogSheet";
import { listarGastoIdsDesdeCorreo } from "../gastos/gastoPorCorreoStore";
import { tagsConSinonimosSeSolapan } from "./write";

/**
 * Gastos de una persona o proyecto por su etiqueta, INCLUIDOS los tickets.
 *
 * Caso real (Carlos, 2026-10-02, gastos de Nuria Ortiz para pedir el reintegro a MIMO): la búsqueda por etiqueta
 * respondió «solo hay 1» y en Holded había 28. Tres causas, corregidas aquí:
 *  1. El listado `GET /purchases` de Holded NO devuelve los tickets (casi todos los gastos de Footprint). Sí se leen
 *     por id, así que se suman las compras que Wobi creó (sus tres registros propios guardan el id de Holded).
 *  2. La etiqueta se comparaba exacta: «nuria» no encontraba «nuriaortiz».
 *  3. El resultado se presentaba como completo: ahora se devuelve la cobertura real para decirla.
 */

interface CompraHolded {
  id: string;
  document_number?: string | null;
  contact_name?: string;
  description?: string | null;
  date?: string;
  currency?: string;
  total?: string | number;
  payments_pending?: string | number;
  payments_detail?: Array<{ amount?: string | number; date?: string; bank_id?: string }>;
  tags?: string[];
}

export interface PagoGasto { fecha: string; importe: number; cuenta: string }

export interface GastoEtiquetado {
  id: string;
  fecha: string;
  proveedor: string;
  descripcion: string;
  numeroDocumento: string;
  total: number;
  moneda: string;
  tags: string[];
  /** Lo que Holded todavía no tiene pagado desde un banco. */
  pendiente: number;
  pagos: PagoGasto[];
  estado: "pagado" | "parcial" | "sin_pagar";
  /** true si no aparece en el listado de facturas de Holded (es un ticket). */
  esTicket: boolean;
}

export interface CoberturaBusqueda {
  facturasListadas: number;
  comprasPropiasLeidas: number;
  /** Compras propias que Holded no devolvió (borradas, o fallo de lectura): pueden faltar gastos. */
  lecturasFallidas: number;
}

const numero = (valor: string | number | null | undefined): number => {
  if (typeof valor === "number") return valor;
  if (!valor) return 0;
  const n = Number(String(valor).replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

const normalizarEtiqueta = (texto: string) =>
  texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * «nuria», «#Nuria» o «Nuria Ortiz» encuentran tanto `nuria` como `nuriaortiz`: la etiqueta coincide si es igual o si
 * una empieza por la otra (mínimo 4 letras, para que «ana» no arrastre «anabel»).
 */
export function etiquetaCoincide(consulta: string, tag: string): boolean {
  const c = normalizarEtiqueta(consulta), t = normalizarEtiqueta(tag);
  if (!c || !t) return false;
  if (c === t) return true;
  const corta = c.length <= t.length ? c : t, larga = c.length <= t.length ? t : c;
  return corta.length >= 4 && larga.startsWith(corta);
}

/** Estado de pago según Holded: pagado = sin saldo pendiente y con al menos un pago registrado desde una cuenta. */
export function estadoDePago(total: number, pendiente: number, pagos: number): GastoEtiquetado["estado"] {
  // Un saldo negativo es un pago de más (p. ej. 3,00 pagados por un gasto de 2,73): está pagado.
  if (pagos > 0 && pendiente <= Math.min(1, Math.max(0.02, Math.abs(total) * 0.005))) return "pagado";
  if (pagos > 0 && pendiente < total) return "parcial";
  return "sin_pagar";
}

function aGasto(c: CompraHolded, cuentas: Map<string, string>, esTicket: boolean): GastoEtiquetado {
  const total = numero(c.total), pendiente = numero(c.payments_pending);
  const pagos = (c.payments_detail ?? [])
    .map((p) => ({ fecha: String(p.date ?? "").slice(0, 10), importe: Math.abs(numero(p.amount)), cuenta: cuentas.get(p.bank_id ?? "") ?? "cuenta no identificada" }))
    .filter((p) => p.importe > 0);
  return {
    id: c.id,
    fecha: String(c.date ?? "").slice(0, 10),
    proveedor: (c.contact_name ?? "").trim() || "(sin proveedor)",
    descripcion: (c.description ?? "").trim(),
    numeroDocumento: (c.document_number ?? "").trim(),
    total,
    moneda: (c.currency ?? "EUR").toUpperCase(),
    tags: c.tags ?? [],
    pendiente,
    pagos,
    estado: estadoDePago(total, pendiente, pagos.length),
    esTicket,
  };
}

/** Variantes de la persona («nuria» ≈ «nuriaortiz») y sinónimos ya conocidos («hospedaje» ≈ «alojamiento»). */
export function tieneEtiqueta(consulta: string, tags: string[]): boolean {
  return tags.some((t) => etiquetaCoincide(consulta, t)) || tagsConSinonimosSeSolapan([consulta], tags);
}

const CONCURRENCIA = 8;

export async function buscarGastosDeEtiqueta(
  empresa: Empresa,
  etiqueta: string,
  desde: string,
  hasta: string
): Promise<{ gastos: GastoEtiquetado[]; cobertura: CoberturaBusqueda }> {
  const enRango = (fecha: string) => fecha >= desde && fecha <= hasta;
  const cuentas = new Map((await listTreasuryAccounts(empresa)).map((c) => [c.id, c.name ?? c.id]));

  // 1) Facturas: el listado de Holded (no trae tickets).
  const listadas: CompraHolded[] = [];
  let cursor: string | undefined;
  for (let pagina = 0; pagina < 60; pagina++) {
    const params = new URLSearchParams({ limit: "100", start_date: desde, end_date: hasta });
    if (cursor) params.set("cursor", cursor);
    const data = (await holdedGet(empresa, `/purchases?${params.toString()}`)) as { items?: CompraHolded[]; cursor?: string; has_more?: boolean };
    listadas.push(...(data.items ?? []));
    if (!data.has_more || !data.cursor) break;
    cursor = data.cursor;
  }
  const porId = new Map<string, GastoEtiquetado>();
  for (const c of listadas) {
    if (c.id && enRango(String(c.date ?? "").slice(0, 10)) && tieneEtiqueta(etiqueta, c.tags ?? [])) {
      // El listado no trae el detalle de pagos (fecha y cuenta): se relee la factura completa.
      const completa = (await holdedGet(empresa, `/purchases/${c.id}`)) as CompraHolded;
      porId.set(c.id, aGasto(completa?.id ? completa : c, cuentas, false));
    }
  }
  const idsListados = new Set(listadas.map((c) => c.id));

  // 2) Tickets: las compras que Wobi creó, leídas una a una por id.
  const propios = new Set<string>();
  for (const id of [
    ...(await durablePurchaseStore.listarIdsDeCompras(empresa)),
    ...(await listarGastoIdsAsignados(empresa)),
    ...(await listarGastoIdsDesdeCorreo(empresa)),
  ]) if (/^[a-f0-9]{24}$/.test(id) && !idsListados.has(id)) propios.add(id);

  let leidas = 0, fallidas = 0;
  const pendientes = [...propios];
  for (let i = 0; i < pendientes.length; i += CONCURRENCIA) {
    const lote = await Promise.all(pendientes.slice(i, i + CONCURRENCIA).map(async (id) => {
      try {
        return (await holdedGet(empresa, `/purchases/${id}`)) as CompraHolded;
      } catch (error) {
        console.error(`[gastosPorEtiqueta] No se pudo leer la compra ${id} de ${empresa}:`, error instanceof Error ? error.message.slice(0, 120) : error);
        return undefined;
      }
    }));
    for (const c of lote) {
      if (!c?.id) { fallidas++; continue; }
      leidas++;
      if (enRango(String(c.date ?? "").slice(0, 10)) && tieneEtiqueta(etiqueta, c.tags ?? [])) {
        porId.set(c.id, aGasto(c, cuentas, true));
      }
    }
  }

  const gastos = [...porId.values()].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.proveedor.localeCompare(b.proveedor));
  return { gastos, cobertura: { facturasListadas: listadas.length, comprasPropiasLeidas: leidas, lecturasFallidas: fallidas } };
}

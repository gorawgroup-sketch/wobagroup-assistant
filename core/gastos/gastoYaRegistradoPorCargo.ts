import { holdedGet, type Empresa } from "../holded/client";
import { proveedorPareceEnDescripcion } from "../holded/write";

/**
 * Caso real (Carlos, 08-10-2026, recibo de Anthropic): el cargo del banco ya estaba conciliado con la compra VJCCOFZT-0016
 * (21,64 €) creada por Wobi el día 7, pero esa compra es un ticket (la API no la lista en /purchases) y el recibo lleva otro
 * número; Wobi decía «ya conciliado con otro documento» y llegó a ofrecer crear el gasto otra vez. Aquí se sigue el cargo
 * hasta su documento: pago del mismo importe y fecha → compra enlazada → si es del mismo proveedor y el mismo importe, el
 * gasto YA está registrado y se dice así. Solo lecturas.
 */
export interface CargoConciliado { monto: number; moneda: string; fecha: string; descripcion?: string }
export interface CompraEnlazada { compraId: string; numero?: string; contacto: string; total: number; fecha: string; moneda?: string }

interface PagoHolded { id?: string; amount?: string | number; date?: string; type?: string; document_id?: string; documentId?: string }
interface CompraHolded { id?: string; contactName?: string; contact_name?: string; total?: string | number; date?: string; docNumber?: string; doc_number?: string; currency?: string }

const numero = (v: unknown): number => {
  if (typeof v === "number") return v;
  const t = String(v ?? "").trim().replace(/\./g, (m, i, s) => (s.includes(",") ? "" : m)).replace(",", ".");
  return Number(t);
};
const centimos = (n: number) => Math.round(Math.abs(n) * 100);

/** Mismo proveedor (por nombre) e importe igual al céntimo: ese documento ES este gasto. */
export function compraEsElMismoGasto(compra: CompraEnlazada, cargo: CargoConciliado, proveedor: string): boolean {
  if (centimos(compra.total) !== centimos(cargo.monto)) return false;
  const p = proveedor.trim();
  if (!p) return false;
  return proveedorPareceEnDescripcion(p, compra.contacto) || proveedorPareceEnDescripcion(compra.contacto, p);
}

export type LectorHolded = <T>(empresa: Empresa, path: string, params?: Record<string, string | undefined>) => Promise<T>;

function diaUnix(fecha: string, desplazamientoDias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + desplazamientoDias);
  return String(Math.floor(d.getTime() / 1000));
}

/** Busca, entre los pagos de Holded de la fecha del cargo (±1 día), la compra enlazada a un pago del mismo importe. */
export async function buscarCompraEnlazadaAlCargo(
  empresa: Empresa,
  cargo: CargoConciliado,
  proveedor: string,
  leer: LectorHolded = holdedGet
): Promise<CompraEnlazada | undefined> {
  const pagos = await leer<PagoHolded[] | { items?: PagoHolded[] }>(empresa, "/payments", {
    starttmp: diaUnix(cargo.fecha, -1), endtmp: diaUnix(cargo.fecha, 2), limit: "100",
  });
  const lista = Array.isArray(pagos) ? pagos : pagos.items ?? [];
  const candidatos = lista.filter((p) => (p.type ?? "purchase") === "purchase" && centimos(numero(p.amount)) === centimos(cargo.monto) && (p.document_id ?? p.documentId));
  for (const pago of candidatos) {
    const id = String(pago.document_id ?? pago.documentId);
    const compra = await leer<CompraHolded>(empresa, `/purchases/${encodeURIComponent(id)}`);
    const enlazada: CompraEnlazada = {
      compraId: String(compra.id ?? id), numero: compra.docNumber ?? compra.doc_number, contacto: String(compra.contactName ?? compra.contact_name ?? ""),
      total: numero(compra.total), fecha: String(compra.date ?? "").slice(0, 10), moneda: compra.currency,
    };
    if (compraEsElMismoGasto(enlazada, cargo, proveedor)) return enlazada;
  }
  return undefined;
}

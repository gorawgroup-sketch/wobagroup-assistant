import { holdedGet, type Empresa } from "../client";
import { evaluarReglaTicket } from "./reglaTicket";
import { registrarDudoso } from "./decisionesTickets";
import { claveTicket, creadoPorWobi } from "./tickets";
import { nuevoTrabajo, type AlmacenTrabajos } from "./trabajos";

/**
 * Exploración de candidatos de la REGLA AMPLIA de conversión a ticket: mira las compras recientes de una empresa que aún son
 * «factura de compra», descarta las que no creó WOBI, aplica la regla y registra en la cola las que son ticket. No toca Holded:
 * la cola decide cuándo actuar (conciliación, comprobante…) y solo actúa con el interruptor de la regla en «activo».
 */
export interface CandidatoRegla { empresa: Empresa; id: string; proveedor: string; total: string; moneda: string; fecha: string; motivos: string[] }
export interface ResultadoEscaneo { revisadas: number; candidatos: CandidatoRegla[]; aRevisar: number; excluidas: number; /** Gastos que la regla no pudo decidir: se pregunta a Carlos con botones. */ dudosos: CandidatoRegla[] }

type Leer = (empresa: Empresa, ruta: string, params?: Record<string, string | undefined>) => Promise<unknown>;
type Raw = Record<string, unknown>;
const num = (v: unknown): number => { const n = Number(String(v ?? "").replace(/\./g, "").replace(",", ".")); return Number.isFinite(n) ? n : NaN; };
/** Tipo de cambio (`currency_change`): Holded lo da en decimal plano («1.12», «3718.16»); si trae coma es formato ES. NO quitar el punto: «1.12» no es 112. */
export const tasaDeCambio = (v: unknown): number => {
  const t = String(v ?? "").trim();
  if (t === "") return NaN;
  const n = t.includes(",") ? Number(t.replace(/\./g, "").replace(",", ".")) : Number(t);
  return Number.isFinite(n) ? n : NaN;
};

/** Ids ya decididos en este proceso: evita volver a leer en cada ciclo lo que no es candidato. */
const vistos = new Map<string, "candidato" | "no_wobi" | "revisar" | "excluida">();
export const reiniciarVistosParaPruebas = () => vistos.clear();

export async function escanearReglaTicket(
  empresa: Empresa, almacen: AlmacenTrabajos, opciones: { leer?: Leer; dias?: number; ahora?: () => number; simulada: boolean },
): Promise<ResultadoEscaneo> {
  const leer = opciones.leer ?? holdedGet;
  const ahora = opciones.ahora ?? Date.now;
  const dia = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const desde = dia(ahora() - (opciones.dias ?? 14) * 86_400_000), hasta = dia(ahora() + 86_400_000);
  const salida: ResultadoEscaneo = { revisadas: 0, candidatos: [], aRevisar: 0, excluidas: 0, dudosos: [] };

  // Aprendizaje: contactos de gastos que ya se convirtieron (completados) en esta empresa.
  const convertidos = new Set<string>();
  for (const t of await almacen.listar({ tipo: "ticket", estados: ["completado"], empresa })) {
    const c = (t.evidencia.antes as { contactId?: string } | undefined)?.contactId;
    if (c) convertidos.add(c);
  }
  const contactos = new Map<string, Raw | null>();

  let cursor: string | undefined;
  for (let pagina = 0; pagina < 20; pagina++) {
    const page = (await leer(empresa, "/purchases", { limit: "100", start_date: desde, end_date: hasta, cursor })) as { items?: Raw[]; cursor?: string; has_more?: boolean };
    for (const item of page.items ?? []) {
      const id = String(item.id);
      const clave = `${empresa}:${id}`;
      if (vistos.has(clave) || (await almacen.obtener(claveTicket(empresa, id)))) continue;
      salida.revisadas++;
      const d = (await leer(empresa, `/purchases/${encodeURIComponent(id)}`)) as Raw;
      if (!creadoPorWobi(d)) { vistos.set(clave, "no_wobi"); continue; }
      const cid = String(d.contact_id ?? "");
      if (cid && !contactos.has(cid)) contactos.set(cid, ((await leer(empresa, `/contacts/${cid}`).catch(() => null)) as Raw | null));
      const contacto = cid ? contactos.get(cid) ?? null : null;
      const nif = (String(contacto?.vat_number ?? contacto?.code ?? "")).trim();
      const moneda = String(d.currency ?? "EUR");
      const total = num(d.total), tasa = tasaDeCambio(d.currency_change);
      const totalEUR = moneda.toUpperCase() === "EUR" ? (Number.isFinite(total) ? total : null) : (Number.isFinite(total) && Number.isFinite(tasa) && tasa > 0 ? total / tasa : null);
      const r = evaluarReglaTicket({
        moneda, totalEUR, tieneNif: nif !== "", pais: String((contacto?.bill_address as Raw | undefined)?.country_code ?? ""),
        proveedorConvertidoAntes: cid !== "" && convertidos.has(cid), textoEvidencia: [d.description, (Array.isArray(d.lines) ? (d.lines as Raw[])[0]?.name : "")].filter(Boolean).join(" · "),
      });
      if (r.decision === "nunca") { vistos.set(clave, "excluida"); salida.excluidas++; continue; }
      if (r.decision === "revisar") {
        vistos.set(clave, "revisar"); salida.aRevisar++;
        // Solo se pregunta por los que WOBI creó, y una sola vez (queda registrado a la espera de la decisión de Carlos).
        const proveedorDudoso = String(d.contact_name ?? item.contact_name ?? "");
        if (await registrarDudoso(almacen, { empresa, id, proveedor: proveedorDudoso, motivos: r.motivos })) salida.dudosos.push({ empresa, id, proveedor: proveedorDudoso, total: String(d.total ?? ""), moneda, fecha: String(d.date ?? ""), motivos: r.motivos });
        continue;
      }
      const proveedor = String(d.contact_name ?? item.contact_name ?? "");
      const t = nuevoTrabajo({ clave: claveTicket(empresa, id), tipo: "ticket", empresa, objetivo: id }, ahora());
      t.evidencia = { origen: "regla_auto", proveedor, motivos: r.motivos, simulada: opciones.simulada, clasificacion: "ticket" };
      await almacen.guardar(t);
      await almacen.evento(t.clave, "candidato_regla", { motivos: r.motivos, simulada: opciones.simulada });
      vistos.set(clave, "candidato");
      salida.candidatos.push({ empresa, id, proveedor, total: String(d.total ?? ""), moneda, fecha: String(d.date ?? ""), motivos: r.motivos });
    }
    if (!page.has_more) break;
    if (!page.cursor) throw new Error("Holded devolvió un listado incompleto al explorar candidatos de ticket.");
    cursor = page.cursor;
  }
  return salida;
}

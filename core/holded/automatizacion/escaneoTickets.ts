import { holdedGet, type Empresa } from "../client";
import { entradaReglaDesdeCompra, evaluarReglaTicket } from "./reglaTicket";
import { convertirProvisionalEnDudoso, registrarDudoso } from "./decisionesTickets";
import { claveTicket, creadoPorWobi } from "./tickets";
import { nuevoTrabajo, type AlmacenTrabajos, type Trabajo } from "./trabajos";

/**
 * Exploración de candidatos de la REGLA AMPLIA de conversión a ticket: mira las compras recientes de una empresa que aún son
 * «factura de compra», descarta las que no creó WOBI, aplica la regla y registra en la cola las que son ticket. No toca Holded:
 * la cola decide cuándo actuar (conciliación, comprobante…) y solo actúa con el interruptor de la regla en «activo».
 */
export interface CandidatoRegla { empresa: Empresa; id: string; proveedor: string; total: string; moneda: string; fecha: string; motivos: string[] }
export interface ResultadoEscaneo { revisadas: number; candidatos: CandidatoRegla[]; aRevisar: number; excluidas: number; /** Gastos que la regla no pudo decidir: se pregunta a Carlos con botones. */ dudosos: CandidatoRegla[] }

type Leer = (empresa: Empresa, ruta: string, params?: Record<string, string | undefined>) => Promise<unknown>;
type Raw = Record<string, unknown>;
export { tasaDeCambio } from "./reglaTicket";

/**
 * Cada gasto que crea WOBI recibe, al nacer, un registro con una clasificación PROVISIONAL del documento (registrarClasificacionDocumento).
 * Si el documento no se declara claramente ticket queda «clasificación dudosa» (requiere_intervencion) u «omitido» (factura declarada),
 * siempre con 0 intentos. Ese registro no es una decisión de la regla ni un intento de conversión: la regla aprobada por Carlos (sin NIF
 * y de fuera de la UE o en divisa → ticket) manda sobre él. Solo se reabre lo que NUNCA se intentó; cualquier otro estado se respeta.
 */
export function puedeReabrirPorRegla(t: Pick<Trabajo, "estado" | "intentos" | "ultimoError" | "evidencia">): boolean {
  if (t.intentos !== 0 || t.evidencia.origen !== "recepcion") return false;
  if (t.estado === "requiere_intervencion") return /Clasificación dudosa/.test(t.ultimoError ?? "");
  return t.estado === "omitido" && t.evidencia.clasificacion === "factura";
}

/** Ids ya decididos en este proceso: evita volver a leer en cada ciclo lo que no es candidato. */
const vistos = new Map<string, "candidato" | "no_wobi" | "revisar" | "excluida">();
export const reiniciarVistosParaPruebas = () => vistos.clear();

export async function escanearReglaTicket(
  empresa: Empresa, almacen: AlmacenTrabajos,
  opciones: { leer?: Leer; dias?: number; ahora?: () => number; simulada: boolean },
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
      if (vistos.has(clave)) continue;
      const previo = await almacen.obtener(claveTicket(empresa, id));
      if (previo && !puedeReabrirPorRegla(previo)) continue;
      salida.revisadas++;
      const d = (await leer(empresa, `/purchases/${encodeURIComponent(id)}`)) as Raw;
      if (!creadoPorWobi(d)) { vistos.set(clave, "no_wobi"); continue; }
      const cid = String(d.contact_id ?? "");
      if (cid && !contactos.has(cid)) contactos.set(cid, ((await leer(empresa, `/contacts/${cid}`).catch(() => null)) as Raw | null));
      const contacto = cid ? contactos.get(cid) ?? null : null;
      const moneda = String(d.currency ?? "EUR");
      const r = evaluarReglaTicket(entradaReglaDesdeCompra(d, contacto, cid !== "" && convertidos.has(cid)));
      if (r.decision === "nunca") { vistos.set(clave, "excluida"); salida.excluidas++; continue; }
      if (r.decision === "revisar") {
        vistos.set(clave, "revisar"); salida.aRevisar++;
        // Solo se pregunta por los que WOBI creó, y una sola vez (queda registrado a la espera de la decisión de Carlos).
        const proveedorDudoso = String(d.contact_name ?? item.contact_name ?? "");
        const preguntar = previo
          ? await convertirProvisionalEnDudoso(almacen, previo, { proveedor: proveedorDudoso, motivos: r.motivos }, ahora())
          : await registrarDudoso(almacen, { empresa, id, proveedor: proveedorDudoso, motivos: r.motivos }, ahora());
        if (preguntar) salida.dudosos.push({ empresa, id, proveedor: proveedorDudoso, total: String(d.total ?? ""), moneda, fecha: String(d.date ?? ""), motivos: r.motivos });
        continue;
      }
      const proveedor = String(d.contact_name ?? item.contact_name ?? "");
      const t = previo ?? nuevoTrabajo({ clave: claveTicket(empresa, id), tipo: "ticket", empresa, objetivo: id }, ahora());
      const clasificacionProvisional = previo ? { estado: previo.estado, clasificacion: previo.evidencia.clasificacion, motivos: previo.evidencia.motivos } : undefined;
      if (previo) { previo.estado = "solicitado"; previo.ultimoError = undefined; previo.actualizadoEn = ahora(); }
      t.evidencia = { ...(previo ? previo.evidencia : {}), origen: "regla_auto", proveedor, motivos: r.motivos, simulada: opciones.simulada, clasificacion: "ticket",
        ...(clasificacionProvisional ? { reabiertoPorRegla: true, clasificacionProvisional } : {}) };
      await almacen.guardar(t);
      await almacen.evento(t.clave, previo ? "reabierto_por_regla" : "candidato_regla", { motivos: r.motivos, simulada: opciones.simulada });
      vistos.set(clave, "candidato");
      salida.candidatos.push({ empresa, id, proveedor, total: String(d.total ?? ""), moneda, fecha: String(d.date ?? ""), motivos: r.motivos });
    }
    if (!page.has_more) break;
    if (!page.cursor) throw new Error("Holded devolvió un listado incompleto al explorar candidatos de ticket.");
    cursor = page.cursor;
  }
  return salida;
}

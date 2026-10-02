import { holdedGet, type Empresa } from "../client";
import { clasificarDocumento, type SenalesDocumento } from "./clasificacionTicket";
import { empresasAutomatizacion, modoAutomatizacion } from "./modo";
import { requiereIntervencion, type NavegadorHolded } from "./navegador";
import { nuevoTrabajo, type AlmacenTrabajos, type Trabajo } from "./trabajos";

/**
 * Conversión de gastos en tickets («Es una factura de compra» desmarcada). La API de Holded NO tiene campo para ello
 * (verificado en la especificación oficial y en lectura real): solo se hace desde la interfaz web, actuando sobre el
 * MISMO gasto (nunca se borra ni se recrea). Un ticket sigue existiendo por id pero desaparece del listado
 * `GET /purchases`: esa ausencia es la prueba de que quedó convertido.
 */
export const MAX_INTENTOS_TICKET = 3;
export const claveTicket = (empresa: Empresa, compraId: string) => `ticket:${empresa}:${compraId}`;

/* ───────── Instantánea y comparación (nada puede cambiar salvo el estado de ticket) ───────── */

export interface InstantaneaCompra {
  contactId: string | null; fecha: string | null; moneda: string | null; cambio: string | null;
  subtotal: string | null; total: string | null; impuestos: string | null; numero: string | null; estado: string | null;
  etiquetas: string[]; cobrado: string | null; pendienteCobro: string | null; pagos: string;
  fechaContable: string | null; fechaDeduccion: string | null;
  /** Estado de borrador/aprobación y vencimiento: guardar desde la interfaz no debe aprobar ni mover fechas. */
  borrador: boolean; aprobado: boolean; vencimiento: string | null;
  lineas: string[];
}

type Raw = Record<string, unknown>;
const txt = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

export function instantaneaCompra(raw: Raw): InstantaneaCompra {
  const lineas = Array.isArray(raw.lines) ? (raw.lines as Raw[]) : [];
  return {
    contactId: txt(raw.contact_id), fecha: txt(raw.date), moneda: txt(raw.currency), cambio: txt(raw.currency_change),
    subtotal: txt(raw.subtotal), total: txt(raw.total), impuestos: txt(raw.tax), numero: txt(raw.document_number), estado: txt(raw.status),
    etiquetas: (Array.isArray(raw.tags) ? raw.tags.map(String) : []).sort(),
    cobrado: txt(raw.payments_total), pendienteCobro: txt(raw.payments_pending),
    pagos: JSON.stringify(raw.payments_detail ?? []),
    fechaContable: txt(raw.accounting_date), fechaDeduccion: txt(raw.deduction_date),
    borrador: raw.draft === true, aprobado: Boolean(raw.approved_at), vencimiento: txt(raw.due_date),
    lineas: lineas.map((l) => JSON.stringify([l.name, l.price, l.units, l.discount, l.tax, [...((l.taxes as unknown[]) ?? [])].sort(), l.account, l.retention, [...((l.tags as unknown[]) ?? [])].sort()])),
  };
}

/** Campos que cambiaron entre antes y después. Cualquier diferencia detiene el caso: no se corrige, se informa. */
export function diferenciasInstantanea(antes: InstantaneaCompra, despues: InstantaneaCompra): string[] {
  return (Object.keys(antes) as Array<keyof InstantaneaCompra>).filter((k) => JSON.stringify(antes[k]) !== JSON.stringify(despues[k]));
}

/* ───────── Lectura del estado real ───────── */

export type EstadoCompra = "factura" | "ticket" | "inexistente";

/** «presente por id + ausente del listado» = ticket. Un fallo de Holded NO es un dato: lanza en vez de deducir. */
export async function estadoRealCompra(
  empresa: Empresa, compraId: string,
  leer: (empresa: Empresa, ruta: string, params?: Record<string, string | undefined>) => Promise<unknown> = holdedGet,
): Promise<{ estado: EstadoCompra; compra?: Raw }> {
  let compra: Raw;
  try { compra = (await leer(empresa, `/purchases/${encodeURIComponent(compraId)}`)) as Raw; }
  catch (error) {
    if ((error as { status?: number }).status === 404) return { estado: "inexistente" };
    throw error;
  }
  const fecha = String(compra.date ?? "").slice(0, 10);
  let cursor: string | undefined;
  for (let pagina = 0; pagina < 20; pagina++) {
    const page = (await leer(empresa, "/purchases", { limit: "100", start_date: fecha || undefined, end_date: fecha || undefined, contact_id: txt(compra.contact_id) ?? undefined, cursor })) as
      { items?: Array<{ id?: string }>; cursor?: string; has_more?: boolean } | Array<{ id?: string }>;
    const items = Array.isArray(page) ? page : page.items ?? [];
    if (items.some((i) => i.id === compraId)) return { estado: "factura", compra };
    const mas = !Array.isArray(page) && page.has_more;
    if (!mas) return { estado: "ticket", compra };
    if (!(page as { cursor?: string }).cursor) throw new Error("Holded devolvió un listado incompleto; no se puede deducir si es ticket.");
    cursor = (page as { cursor?: string }).cursor;
  }
  throw new Error("El listado de compras superó el máximo de páginas; no se puede deducir si es ticket.");
}

/* ───────── Registro al recibir el documento ───────── */

export async function registrarClasificacionDocumento(
  almacen: AlmacenTrabajos, entrada: { empresa: Empresa; compraId: string } & SenalesDocumento, ahora: number = Date.now(),
): Promise<Trabajo | undefined> {
  if (modoAutomatizacion("TICKETS") === "apagado") return undefined;
  const clave = claveTicket(entrada.empresa, entrada.compraId);
  if (await almacen.obtener(clave)) return undefined; // idempotente
  const c = clasificarDocumento(entrada);
  const t = nuevoTrabajo({ clave, tipo: "ticket", empresa: entrada.empresa, objetivo: entrada.compraId }, ahora);
  t.evidencia = { proveedor: entrada.proveedor, clasificacion: c.tipo, motivos: c.motivos, senales: c.senales, origen: "recepcion" };
  t.estado = c.tipo === "ticket" ? "solicitado" : c.tipo === "factura" ? "omitido" : "requiere_intervencion";
  if (c.tipo === "revisar") t.ultimoError = "Clasificación dudosa: pendiente de revisión";
  await almacen.guardar(t);
  await almacen.evento(clave, "clasificado", { tipo: c.tipo, motivos: c.motivos });
  return t;
}

/* ───────── Procesado de la cola ───────── */

export interface DependenciasTickets {
  almacen: AlmacenTrabajos;
  navegador?: () => NavegadorHolded | undefined;
  leer?: (empresa: Empresa, ruta: string, params?: Record<string, string | undefined>) => Promise<unknown>;
  ahora?: () => number;
  /** Empresas con un caso controlado aprobado; si se define, solo esos ids se tocan (alcance de la prueba). */
  soloIds?: ReadonlySet<string>;
}
export interface ResumenTickets { modo: string; revisados: number; porEstado: Record<string, number>; detalle: Array<{ clave: string; estado: string; nota?: string }> }

export async function procesarColaTickets(dep: DependenciasTickets): Promise<ResumenTickets> {
  const modo = modoAutomatizacion("TICKETS");
  const ahora = dep.ahora ?? Date.now;
  const resumen: ResumenTickets = { modo, revisados: 0, porEstado: {}, detalle: [] };
  if (modo === "apagado") return resumen;
  const empresas = new Set<string>(empresasAutomatizacion("TICKETS"));
  const cola = (await dep.almacen.listar({ tipo: "ticket", estados: ["solicitado"] })).filter((t) => empresas.has(t.empresa) && (!dep.soloIds || dep.soloIds.has(t.objetivo)));
  for (const job of cola) {
    const r = await dep.almacen.conExclusion(job.clave, () => procesarTicket(job.clave, modo, dep, ahora));
    const t = r === "ocupado" ? await dep.almacen.obtener(job.clave) : r;
    resumen.revisados++;
    const estado = t?.estado ?? "en_curso";
    resumen.porEstado[estado] = (resumen.porEstado[estado] ?? 0) + 1;
    resumen.detalle.push({ clave: job.clave, estado, nota: t?.ultimoError });
  }
  return resumen;
}

async function procesarTicket(clave: string, modo: string, dep: DependenciasTickets, ahora: () => number): Promise<Trabajo> {
  const t = (await dep.almacen.obtener(clave))!;
  if (t.estado !== "solicitado") return t; // otra ejecución ya lo resolvió
  const empresa = t.empresa as Empresa;
  const guardar = async (estado: Trabajo["estado"], error?: string) => { t.estado = estado; t.ultimoError = error; t.actualizadoEn = ahora(); await dep.almacen.guardar(t); return t; };
  let real;
  try { real = await estadoRealCompra(empresa, t.objetivo, dep.leer); }
  catch (error) { return guardar("solicitado", `Lectura de Holded fallida; se reintenta: ${msg(error)}`); }
  if (real.estado === "inexistente") return guardar("fallido", "El gasto ya no existe en Holded");
  if (real.estado === "ticket") { t.evidencia.yaEraTicket = true; t.verificadoEn = ahora(); return guardar("omitido", undefined); }
  const antes = instantaneaCompra(real.compra!);
  t.evidencia.antes = antes;
  // La simulación NO consume el trabajo: lo deja en cola (solicitado) con lo que haría, para que al activarlo se ejecute.
  if (modo === "simulacion") { t.evidencia.simulacion = { en: ahora(), haria: "desmarcar «Es una factura de compra»", cobrado: antes.cobrado, borrador: antes.borrador }; return guardar("solicitado"); }

  const navegador = dep.navegador?.();
  if (!navegador) return guardar("requiere_intervencion", "Sin sesión web de Holded configurada en el servidor");
  t.intentos++;
  t.solicitadoEn = ahora();
  await dep.almacen.guardar(t);
  const r = await navegador.desmarcarFacturaDeCompra(empresa, t.objetivo, { borrador: antes.borrador }).catch((e): { estado: "error"; detalle: string } => ({ estado: "error", detalle: msg(e) }));
  await dep.almacen.evento(clave, "guardado_en_holded", { resultado: r });
  if (requiereIntervencion(r)) return guardar("requiere_intervencion", (r as { detalle?: string }).detalle);

  // Aunque el navegador diga error, el guardado pudo haberse aplicado: SIEMPRE se mira el estado real.
  let despues;
  try { despues = await estadoRealCompra(empresa, t.objetivo, dep.leer); }
  catch (error) { return guardar("solicitado", `Guardado sin verificar (lectura fallida); se comprobará el estado real antes de repetir: ${msg(error)}`); }
  t.verificadoEn = ahora();
  if (despues.estado === "ticket" && despues.compra) {
    const diffs = diferenciasInstantanea(antes, instantaneaCompra(despues.compra));
    t.evidencia.despues = instantaneaCompra(despues.compra);
    if (diffs.length > 0) { t.evidencia.camposCambiados = diffs; return guardar("requiere_intervencion", `Convertido, pero cambiaron campos inesperados: ${diffs.join(", ")}`); }
    return guardar("completado");
  }
  if (r.estado === "ok") return guardar("no_confirmado", "Se guardó pero Holded sigue mostrándolo como factura de compra");
  return t.intentos >= MAX_INTENTOS_TICKET ? guardar("fallido", (r as { detalle?: string }).detalle) : guardar("solicitado", (r as { detalle?: string }).detalle);
}

/* ───────── Inventario de candidatos antiguos (solo lectura; nunca conversión masiva) ───────── */

const PAISES_UE = new Set(["ES","AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","SE"]);

export interface CandidatoTicket { empresa: Empresa; compraId: string; proveedor: string; fecha: string; total: string; moneda: string; numero: string | null; conciliado: boolean; nivel: "probable" | "revisar"; motivos: string[] }

export async function inventarioCandidatos(
  empresa: Empresa, desde: string, hasta: string,
  leer: (empresa: Empresa, ruta: string, params?: Record<string, string | undefined>) => Promise<unknown> = holdedGet,
): Promise<CandidatoTicket[]> {
  const salida: CandidatoTicket[] = [];
  const contactos = new Map<string, Raw | null>();
  let cursor: string | undefined;
  for (let pagina = 0; pagina < 50; pagina++) {
    const page = (await leer(empresa, "/purchases", { limit: "100", start_date: desde, end_date: hasta, cursor })) as { items?: Raw[]; cursor?: string; has_more?: boolean };
    for (const c of page.items ?? []) {
      const cid = txt(c.contact_id);
      if (cid && !contactos.has(cid)) contactos.set(cid, ((await leer(empresa, `/contacts/${cid}`).catch(() => null)) as Raw | null));
      const contacto = cid ? contactos.get(cid) ?? null : null;
      // Contrastado con la API real: el NIF/identificación del contacto va en `code` (o `vat_number`) y el país en
      // `bill_address.country_code`. Un proveedor sin identificación fiscal y de fuera de la UE es el patrón típico de ticket.
      const nif = (txt(contacto?.vat_number) ?? txt(contacto?.code))?.trim() || null;
      const pais = (txt((contacto?.bill_address as Raw | undefined)?.country_code) ?? "").toUpperCase();
      const extranjeroSinNif = Boolean(contacto) && !nif && pais !== "" && !PAISES_UE.has(pais);
      const conciliado = txt(c.payments_total) !== null && txt(c.payments_total) !== "0,00";
      salida.push({ empresa, compraId: String(c.id), proveedor: String(c.contact_name ?? ""), fecha: String(c.date ?? ""), total: String(c.total ?? ""), moneda: String(c.currency ?? ""),
        numero: txt(c.document_number), conciliado, nivel: extranjeroSinNif ? "probable" : "revisar",
        motivos: extranjeroSinNif ? ["proveedor de fuera de la UE sin identificación fiscal (patrón habitual de tickets)"] : ["sin evidencia documental suficiente: requiere revisión humana"] });
    }
    if (!page.has_more) break;
    if (!page.cursor) throw new Error("Holded devolvió un listado incompleto al inventariar candidatos.");
    cursor = page.cursor;
  }
  return salida;
}

function msg(e: unknown): string { return (e instanceof Error ? e.message : String(e)).slice(0, 300); }
export type { SenalesDocumento };

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
  /** Fecha/hora de aprobación: INFORMATIVA (Holded puede volver a sellarla al guardar); se registra pero no detiene el caso. */
  aprobadoEn: string | null;
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
    borrador: raw.draft === true, aprobado: Boolean(raw.approved_at), vencimiento: txt(raw.due_date), aprobadoEn: txt(raw.approved_at),
    lineas: lineas.map((l) => JSON.stringify([l.name, l.price, l.units, l.discount, l.tax, [...((l.taxes as unknown[]) ?? [])].sort(), l.account, l.retention, [...((l.tags as unknown[]) ?? [])].sort()])),
  };
}

const CAMPOS_INFORMATIVOS: ReadonlyArray<keyof InstantaneaCompra> = ["aprobadoEn"];
const CAMPOS_LINEA = ["concepto", "precio", "unidades", "descuento", "impuesto", "impuestos", "cuenta", "retencion", "etiquetas"];

/** Campos BLOQUEANTES que cambiaron entre antes y después. Cualquier diferencia detiene el caso: no se corrige, se informa. */
export function diferenciasInstantanea(antes: InstantaneaCompra, despues: InstantaneaCompra): string[] {
  return (Object.keys(antes) as Array<keyof InstantaneaCompra>)
    .filter((k) => !CAMPOS_INFORMATIVOS.includes(k) && JSON.stringify(antes[k]) !== JSON.stringify(despues[k]));
}

/**
 * Efectos NORMALES de Holded al dejar de ser «factura de compra» (confirmado por Carlos y en la interfaz real, 2026-10-02):
 * un ticket no lleva impuestos, así que Holded quita los impuestos de las líneas (p. ej. «Inversión del sujeto pasivo») y copia
 * las etiquetas del gasto a la línea. Solo se aceptan bajo condiciones estrictas; cualquier otra diferencia sigue deteniendo el caso.
 */
function esCambioNormalDeTicket(d: DetalleDiferencia, antes: InstantaneaCompra, despues: InstantaneaCompra): boolean {
  const ivaAntes = Number(String(antes.impuestos ?? "0").replace(/\./g, "").replace(",", "."));
  // Los impuestos de la línea pueden quedar vacíos SOLO si el documento no tenía un importe real de IVA (si lo tenía, el total cambiaría).
  if (/^linea\[\d+\]\.impuestos$/.test(d.campo)) return d.despues === "[]" && Number.isFinite(ivaAntes) && ivaAntes === 0;
  // Las etiquetas del gasto aparecen también en la línea (antes vacía): solo si la línea refleja EXACTAMENTE las etiquetas del
  // documento. Las etiquetas del documento nunca deben cambiar (son lo que permite identificar la transacción): si cambian,
  // el campo «etiquetas» difiere y detiene el caso por su cuenta.
  if (/^linea\[\d+\]\.etiquetas$/.test(d.campo)) {
    if (d.antes !== "[]") return false;
    try { return JSON.stringify([...(JSON.parse(d.despues) as string[])].sort()) === JSON.stringify([...despues.etiquetas].sort()) && antes.etiquetas.length === despues.etiquetas.length; }
    catch { return false; }
  }
  return false;
}

/** Campos que cambiaron y NO son un efecto normal de pasar a ticket ni informativos: estos sí detienen el caso. */
export function diferenciasInesperadas(antes: InstantaneaCompra, despues: InstantaneaCompra): string[] {
  return detalleDiferencias(antes, despues).filter((d) => !d.informativo && !esCambioNormalDeTicket(d, antes, despues)).map((d) => d.campo);
}

/**
 * Casos que antes de conocer estos efectos normales quedaron en «requiere intervención» solo por ellos: si ahora todas sus
 * diferencias son normales y el gasto es ticket, se cierran como completados (el registro conserva el detalle y un evento).
 */
export async function reevaluarCambiosNormales(almacen: AlmacenTrabajos): Promise<number> {
  let cerrados = 0;
  for (const t of await almacen.listar({ tipo: "ticket", estados: ["requiere_intervencion"] })) {
    const antes = t.evidencia.antes as InstantaneaCompra | undefined;
    const despues = t.evidencia.despues as InstantaneaCompra | undefined;
    if (!antes || !despues || !Array.isArray(t.evidencia.camposCambiados)) continue;
    if (diferenciasInesperadas(antes, despues).length > 0) continue;
    t.estado = "completado"; t.ultimoError = undefined; t.actualizadoEn = Date.now();
    t.evidencia.camposCambiados = undefined;
    await almacen.guardar(t);
    await almacen.evento(t.clave, "reevaluado_cambios_normales", { motivo: "impuestos de línea y etiquetas: efecto normal de pasar a ticket" });
    cerrados++;
  }
  return cerrados;
}

const TICKET_TRANSITORIO = /empresa activa|Cambiar cuenta|lista de cuentas|No se abrió|No se pudo activar|No se encontró|Lectura de|sin verificar|superó|timeout/i;
const TICKET_HUMANO = /sesión|sesion|verificaci[oó]n|CAPTCHA|consentimiento|Sin sesión|inesperados/i;

/**
 * Casos que quedaron en «requiere intervención» por un fallo TRANSITORIO de pantalla ANTES de que el sistema distinguiera esos
 * fallos (no llegaron a guardarse en Holded): se reabren para el siguiente ciclo, con el límite de intentos. Nunca los que exigen
 * a una persona ni los que ya guardaron algo (esos tienen «después» y se revisan por sus diferencias).
 */
export async function reabrirTicketsTransitorios(almacen: AlmacenTrabajos): Promise<number> {
  let reabiertos = 0;
  for (const t of await almacen.listar({ tipo: "ticket", estados: ["requiere_intervencion"] })) {
    const motivo = t.ultimoError ?? "";
    if (t.evidencia.despues || t.intentos >= MAX_INTENTOS_TICKET) continue;
    if (TICKET_HUMANO.test(motivo) || !TICKET_TRANSITORIO.test(motivo)) continue;
    t.estado = "solicitado"; t.actualizadoEn = Date.now();
    await almacen.guardar(t);
    await almacen.evento(t.clave, "reabierto_transitorio", { motivo });
    reabiertos++;
  }
  return reabiertos;
}

export interface DetalleDiferencia { campo: string; antes: string; despues: string; informativo?: boolean }
const corto = (v: unknown) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > 140 ? `${s.slice(0, 140)}…` : s; };

/** Detalle legible de TODO lo que cambió (valor anterior y posterior), incluidos los campos informativos y cada campo de cada línea. */
export function detalleDiferencias(antes: InstantaneaCompra, despues: InstantaneaCompra): DetalleDiferencia[] {
  const salida: DetalleDiferencia[] = [];
  for (const k of Object.keys(antes) as Array<keyof InstantaneaCompra>) {
    if (JSON.stringify(antes[k]) === JSON.stringify(despues[k])) continue;
    const informativo = CAMPOS_INFORMATIVOS.includes(k);
    if (k !== "lineas") { salida.push({ campo: k, antes: corto(antes[k]), despues: corto(despues[k]), informativo }); continue; }
    const n = Math.max(antes.lineas.length, despues.lineas.length);
    for (let i = 0; i < n; i++) {
      const a = antes.lineas[i] ? (JSON.parse(antes.lineas[i]) as unknown[]) : undefined;
      const d = despues.lineas[i] ? (JSON.parse(despues.lineas[i]) as unknown[]) : undefined;
      if (!a || !d) { salida.push({ campo: `linea[${i}]`, antes: a ? "existía" : "no existía", despues: d ? "existe" : "no existe" }); continue; }
      CAMPOS_LINEA.forEach((nombre, j) => { if (JSON.stringify(a[j]) !== JSON.stringify(d[j])) salida.push({ campo: `linea[${i}].${nombre}`, antes: corto(a[j]), despues: corto(d[j]) }); });
    }
  }
  return salida;
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

/* ───────── Elegibilidad: creado por WOBI + conciliado + completo con comprobante ───────── */

export const ESPERA_MAXIMA_ELEGIBILIDAD_MS = 21 * 24 * 3_600_000;
/** Marcador opaco que WOBI guarda en las notas de cada gasto que crea (`[wobi:<hash>]`). */
const MARCADOR_WOBI = /^\[wobi:[0-9a-f]{16,}\]$/i;

export interface Elegibilidad { elegible: boolean; /** true = podría llegar a serlo (falta conciliar/adjuntar); false = no aplica */ esperar: boolean; motivos: string[] }

export function evaluarElegibilidad(raw: Raw, adjuntos: number): Elegibilidad {
  if (!MARCADOR_WOBI.test(String(raw.notes ?? "").trim())) return { elegible: false, esperar: false, motivos: ["no lo creó WOBI (sin marcador propio en las notas)"] };
  const faltan: string[] = [];
  const num = (v: unknown) => Number(String(v ?? "").replace(/\./g, "").replace(",", "."));
  const pagos = Array.isArray(raw.payments_detail) ? (raw.payments_detail as Raw[]) : [];
  const total = num(raw.total);
  if (!(num(raw.payments_total) > 0) || Math.abs(num(raw.payments_pending)) > 0.001 || !pagos.some((p) => txt(p.bank_id))) faltan.push("no está conciliado con el banco");
  if (adjuntos < 1) faltan.push("no tiene comprobante adjunto");
  const lineas = Array.isArray(raw.lines) ? (raw.lines as Raw[]) : [];
  if (!txt(raw.contact_id) || !(total > 0) || lineas.length === 0 || lineas.some((l) => !txt(l.account)) || raw.status !== "completed") faltan.push("el gasto no está completo (contacto, importe, líneas con cuenta o estado)");
  return faltan.length === 0 ? { elegible: true, esperar: false, motivos: [] } : { elegible: false, esperar: true, motivos: faltan };
}

async function contarAdjuntos(empresa: Empresa, compraId: string, leer: NonNullable<DependenciasTickets["leer"]> = holdedGet): Promise<number> {
  const r = (await leer(empresa, `/purchases/${encodeURIComponent(compraId)}/attachments`)) as { items?: unknown[] } | unknown[];
  return Array.isArray(r) ? r.length : (r.items ?? []).length;
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
  if (!t.evidencia.proveedor) t.evidencia.proveedor = String((real.compra as { contact_name?: string } | undefined)?.contact_name ?? "");
  // Regla de Carlos: solo gastos que WOBI creó, ya conciliados y completos con su comprobante. Se comprueba SIEMPRE antes de actuar.
  let adjuntos: number;
  try { adjuntos = await contarAdjuntos(empresa, t.objetivo, dep.leer); }
  catch (error) { return guardar("solicitado", `Lectura de adjuntos fallida; se reintenta: ${msg(error)}`); }
  const elegibilidad = evaluarElegibilidad(real.compra!, adjuntos);
  t.evidencia.elegibilidad = { ...elegibilidad, en: ahora() };
  if (!elegibilidad.elegible) {
    if (!elegibilidad.esperar) return guardar("omitido", `No se convierte: ${elegibilidad.motivos.join("; ")}`);
    // Aún le falta algo (p. ej. conciliación): se espera en cola; si pasan demasiados días, lo decide una persona.
    if (ahora() - t.creadoEn > ESPERA_MAXIMA_ELEGIBILIDAD_MS) return guardar("requiere_intervencion", `No llegó a estar completo y conciliado: ${elegibilidad.motivos.join("; ")}`);
    return guardar("solicitado", `Esperando: ${elegibilidad.motivos.join("; ")}`);
  }
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
    const diffs = diferenciasInesperadas(antes, instantaneaCompra(despues.compra));
    t.evidencia.despues = instantaneaCompra(despues.compra);
    t.evidencia.diferencias = detalleDiferencias(antes, instantaneaCompra(despues.compra));
    if (diffs.length > 0) { t.evidencia.camposCambiados = diffs; return guardar("requiere_intervencion", `Convertido, pero cambiaron campos inesperados: ${diffs.join(", ")}`); }
    return guardar("completado");
  }
  if (r.estado === "ok") return guardar("no_confirmado", "Se guardó pero Holded sigue mostrándolo como factura de compra");
  return t.intentos >= MAX_INTENTOS_TICKET ? guardar("fallido", (r as { detalle?: string }).detalle) : guardar("solicitado", (r as { detalle?: string }).detalle);
}

/* ───────── Inventario de candidatos antiguos (solo lectura; nunca conversión masiva) ───────── */

const PAISES_UE = new Set(["ES","AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","SE"]);

export interface CandidatoTicket { empresa: Empresa; compraId: string; proveedor: string; fecha: string; total: string; moneda: string; numero: string | null; conciliado: boolean; nivel: "probable" | "revisar"; motivos: string[]; /** Solo se calcula para los probables: creado por WOBI + conciliado + completo con comprobante. */ elegible?: boolean; faltantes?: string[] }

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
      const candidato: CandidatoTicket = { empresa, compraId: String(c.id), proveedor: String(c.contact_name ?? ""), fecha: String(c.date ?? ""), total: String(c.total ?? ""), moneda: String(c.currency ?? ""),
        numero: txt(c.document_number), conciliado, nivel: extranjeroSinNif ? "probable" : "revisar",
        motivos: extranjeroSinNif ? ["proveedor de fuera de la UE sin identificación fiscal (patrón habitual de tickets)"] : ["sin evidencia documental suficiente: requiere revisión humana"] };
      // Solo los probables se someten a la regla completa (creado por WOBI + conciliado + comprobante): son pocas lecturas extra.
      if (extranjeroSinNif) {
        try {
          const detalle = (await leer(empresa, `/purchases/${encodeURIComponent(String(c.id))}`)) as Raw;
          const e = evaluarElegibilidad(detalle, await contarAdjuntos(empresa, String(c.id), leer));
          candidato.elegible = e.elegible; candidato.faltantes = e.motivos;
        } catch { candidato.faltantes = ["no se pudo comprobar la elegibilidad (lectura de Holded fallida)"]; }
      }
      salida.push(candidato);
    }
    if (!page.has_more) break;
    if (!page.cursor) throw new Error("Holded devolvió un listado incompleto al inventariar candidatos.");
    cursor = page.cursor;
  }
  return salida;
}

function msg(e: unknown): string { return (e instanceof Error ? e.message : String(e)).slice(0, 300); }
export type { SenalesDocumento };

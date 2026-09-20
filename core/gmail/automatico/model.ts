import { createHash } from "node:crypto";

export type EmpresaAuto = "WOBA" | "EWORKS" | "Footprint";
export type ModoAuto = "off" | "simulate" | "execute";
export const VERSION_POLITICA = "correo-gastos-v12";
export const VENTANA_DIAS_MOVIMIENTO_AUTO = 5;
export interface ConfigAuto {
  modo: ModoAuto;
  empresas: EmpresaAuto[];
  buzon: string;
}
export function configuracionAuto(env: NodeJS.ProcessEnv = process.env): ConfigAuto {
  const valor = env.WOBI_MAIL_AUTO_MODE ?? "off";
  if (!["off", "simulate", "execute"].includes(valor)) throw new Error("WOBI_MAIL_AUTO_MODE inválido.");
  const empresas = (env.WOBI_MAIL_AUTO_COMPANIES ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (empresas.some(e => !["WOBA", "EWORKS", "Footprint"].includes(e))) throw new Error("Empresa automática inválida.");
  return { modo: env.WOBI_MAIL_AUTO_KILL_SWITCH === "true" ? "off" : valor as ModoAuto,
    empresas: empresas as EmpresaAuto[], buzon: env.GMAIL_IMPERSONATE_EMAIL ?? "" };
}
export const hash = (valor: string | Buffer): string => createHash("sha256").update(valor).digest("hex");
export const normalizar = (s: string): string => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
export const normalizarProveedorComparable = (valor: string): string => normalizar(valor.replace(/\s*\([^)]*\)\s*$/, ""))
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .replace(/\b(sociedad anonima unipersonal|sociedad anonima|sociedad limitada unipersonal|sociedad limitada|sociedad por acciones simplificada|s a s|s a u|s l u|s r o|s r l|s a|s l|sas|sau|sa|slu|sl|sro|srl|llc|ltd|inc)\b/g, " ")
  .replace(/\s+/g, " ").trim();
const tokensProveedor = (valor: string): string[] => normalizarProveedorComparable(valor).split(" ").filter(t => t.length >= 3);
const proveedorCompacto = (valor: string): string => normalizarProveedorComparable(valor).replace(/\s+/g, "");
function bigramasProveedor(valor: string): Set<string> {
  const compacto = proveedorCompacto(valor);
  return new Set(Array.from({ length: Math.max(0, compacto.length - 1) }, (_, i) => compacto.slice(i, i + 2)));
}
/** Puntaje ortográfico auxiliar. Nunca autoriza por sí solo una escritura. */
export function similitudProveedor(a: string, b: string): number {
  const aa = bigramasProveedor(a), bb = bigramasProveedor(b);
  if (!aa.size || !bb.size) return 0;
  let comunes = 0;
  for (const x of aa) if (bb.has(x)) comunes++;
  return (2 * comunes) / (aa.size + bb.size);
}
/** Variación determinista: misma razón social compacta o nombre legal completo contenido en el otro. */
export function nombresProveedorEquivalentes(a: string, b: string): boolean {
  const na = normalizarProveedorComparable(a), nb = normalizarProveedorComparable(b);
  if (!na || !nb) return false;
  if (na === nb || proveedorCompacto(a) === proveedorCompacto(b)) return true;
  const ta = tokensProveedor(a), tb = tokensProveedor(b);
  if (ta.length < 2 || tb.length < 2) return false;
  const [cortos, largos] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)];
  return cortos.length >= 2 && cortos.every(token => largos.has(token));
}
/** Coincidencia conservadora: un nombre debe contener todos los tokens relevantes del nombre más corto. */
export function nombresProveedorCompatibles(a: string, b: string): boolean {
  const na = normalizarProveedorComparable(a), nb = normalizarProveedorComparable(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = tokensProveedor(a), tb = tokensProveedor(b);
  if (!ta.length || !tb.length) return false;
  const [cortos, largos] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)];
  return cortos.every(token => largos.has(token));
}
/** El descriptor bancario confirma el proveedor por frase o por tokens completos; nunca por fragmentos parciales. */
export function proveedorEnDescripcion(proveedor: string, descripcion: string): boolean {
  const p = normalizarProveedorComparable(proveedor), d = normalizar(descripcion);
  if (!p || !d) return false;
  if (` ${d} `.includes(` ${p} `) || (d.length >= 3 && ` ${p} `.includes(` ${d} `))) return true;
  const tokensDescripcion = new Set(d.split(" ").filter(t => t.length >= 3));
  const tokens = tokensProveedor(proveedor);
  return tokens.length > 0 && tokens.every(token => tokensDescripcion.has(token));
}
export function diferenciaDiasCalendario(a: string, b: string): number {
  const da = Date.parse(a.slice(0, 10)), db = Date.parse(b.slice(0, 10));
  return Number.isFinite(da) && Number.isFinite(db) ? Math.abs(da - db) / 86_400_000 : Number.POSITIVE_INFINITY;
}
export function dinero(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 ||
      !Number.isSafeInteger(Math.round(n * 100)) || Math.abs(n * 100 - Math.round(n * 100)) > 0.000001) {
    throw new Error("Importe ausente, no positivo o con más de dos decimales.");
  }
  return Math.round(n * 100);
}
export function fechaValida(fecha: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(fecha) && Number.isFinite(Date.parse(fecha)) &&
    new Date(fecha).toISOString().slice(0, 10) === fecha;
}
export interface AdjuntoAuto { id: string; nombre: string; mime: string; data: Buffer }
export interface CorreoAuto {
  id: string; threadId: string; de: string; asunto: string; fecha: string; recibidoEn: number;
  cuerpo: string; contextoHilo: string; adjuntos: AdjuntoAuto[];
  /** SHA de cuerpo y adjuntos; nunca se usa el hilo como identidad del comprobante. */
  huella: string; lecturaError?: string;
}
export interface ReciboAuto {
  fuente: string; // "cuerpo" o ID de adjunto, siempre contrastado contra Gmail
  tipo: "ticket" | "recibo" | "factura" | "otro";
  confianza: "alta" | "media" | "baja";
  empresa: EmpresaAuto | "desconocida";
  proveedor: string; numero?: string; fecha: string; moneda: string; monto: number;
  equivalente?: { moneda: string; monto: number };
  concepto: string; persona?: string; viaje?: boolean;
  /** Texto real del correo que aporta la categoría cuando el ticket solo imprime un nombre genérico. */
  contextoClasificacion?: string;
  evidencia: string; evidenciaEmpresa: string;
}
export interface MonedaDocumentoAuto {
  moneda: string;
  monto: number;
  tasaCambio?: number;
}
/**
 * Conserva el importe y la moneda impresos en el comprobante. El equivalente
 * bancario solo aporta la conversión contable demostrada por el propio
 * documento; nunca sustituye el precio nativo de la compra.
 */
export function monedaDocumentoAuto(recibo: ReciboAuto): MonedaDocumentoAuto {
  const moneda = recibo.moneda.toUpperCase().trim();
  if (!/^[A-Z]{3}$/.test(moneda) || !Number.isFinite(recibo.monto) || recibo.monto <= 0) {
    throw new Error("importe_o_moneda_nativa_invalida");
  }
  if (moneda === "EUR") return { moneda, monto: recibo.monto };
  const equivalente = recibo.equivalente;
  if (equivalente?.moneda.toUpperCase().trim() !== "EUR" ||
      !Number.isFinite(equivalente.monto) || equivalente.monto <= 0) {
    return { moneda, monto: recibo.monto };
  }
  const tasaCambio = Number((recibo.monto / equivalente.monto).toFixed(6));
  if (!Number.isFinite(tasaCambio) || tasaCambio <= 0) throw new Error("tasa_cambio_recibo_invalida");
  return { moneda, monto: recibo.monto, tasaCambio };
}
export interface AnalisisAuto {
  completo: boolean; resumen: string; otrasAcciones: boolean;
  recibos: ReciboAuto[]; motivoManual?: string;
}
export interface MovimientoAuto {
  id: string; cuentaId: string; moneda: string; fecha: string; centimos: number;
  conciliadoCentimos: number; estado: string; descripcion: string; origen: string;
}
export interface EvidenciaAuto {
  empresaDetectada?: EmpresaAuto;
  contacto?: { id: string; nombre: string; exacto: boolean;
    metodo?: "nombre_exacto" | "nombre_equivalente" | "alias_confirmado" | "aproximado_unico"; similitud?: number };
  motivoProveedor?: "sin_coincidencias" | "coincidencia_ambigua" | "alias_contradictorio";
  candidatosProveedor?: Array<{ id: string; nombre: string; similitud: number }>;
  cuenta?: { id: string; evidencia: string; tags?: string[]; nombre?: string };
  duplicados: string[];
  consultasCompletas: boolean;
  movimientos: MovimientoAuto[];
  /** Procedimiento autorizado: compra seguida de conversión manual a ticket. */
  permiteTicket: boolean;
  motivoTipoDocumento?: string;
  confianzaReforzada?: string;
}
export interface PlanAuto {
  empresa: EmpresaAuto; contactoId: string; cuentaId?: string;
  recibo: ReciboAuto; movimiento: MovimientoAuto; totalCentimos: number;
  toleranciaCentimos: number; diferenciaCentimos: number; regla: string;
  claves: string[]; fuenteHash: string; correo: { id: string; threadId: string; buzon: string };
  version: string; evidencia: EvidenciaAuto;
}
export type DecisionAuto = { apto: true; plan: PlanAuto } | { apto: false; motivos: string[] };

export function toleranciaMontoAuto(esperadoCentimos: number): number {
  return Math.min(500, Math.max(5, Math.round(esperadoCentimos * 0.02)));
}

function datosMonto(r: ReciboAuto): { esperado: number; moneda: string; convertido: boolean; tolerancia: number } {
  let esperado = dinero(r.monto), moneda = r.moneda, convertido = false;
  if (r.equivalente) {
    esperado = dinero(r.equivalente.monto);
    moneda = r.equivalente.moneda;
    if (!/^[A-Z]{3}$/.test(moneda) || moneda === r.moneda) throw new Error("Equivalente inválido.");
    convertido = true;
  }
  // Un cargo bancario puede diferir por redondeo, propina o liquidación del comercio.
  // La banda sigue siendo angosta y solo autoriza si queda un único movimiento verificable.
  return { esperado, moneda, convertido, tolerancia: toleranciaMontoAuto(esperado) };
}

export function candidatosMovimientoAuto(r: ReciboAuto, e: EvidenciaAuto): MovimientoAuto[] {
  let datos: ReturnType<typeof datosMonto>;
  try { datos = datosMonto(r); } catch { return []; }
  const porMontoYFecha = e.movimientos.filter(m => m.moneda === datos.moneda &&
    diferenciaDiasCalendario(m.fecha, r.fecha) <= VENTANA_DIAS_MOVIMIENTO_AUTO &&
    Number.isSafeInteger(m.centimos) && m.centimos < 0 && Math.abs(-m.centimos - datos.esperado) <= datos.tolerancia);
  if (porMontoYFecha.length <= 1) return porMontoYFecha;
  const porProveedor = porMontoYFecha.filter(m => proveedorEnDescripcion(r.proveedor, m.descripcion) ||
    Boolean(e.contacto?.nombre && proveedorEnDescripcion(e.contacto.nombre, m.descripcion)));
  return porProveedor.length === 1 ? porProveedor : porMontoYFecha;
}

/** La clasificación nunca autoriza una escritura sin contrastes deterministas. */
export function evaluarAuto(c: CorreoAuto, a: AnalisisAuto, r: ReciboAuto, e: EvidenciaAuto, config: ConfigAuto): DecisionAuto {
  const motivos: string[] = [];
  const empresaEvaluada = e.empresaDetectada ?? r.empresa;
  if (!a.completo) motivos.push("lectura_incompleta");
  if (!new Set(["ticket", "recibo"]).has(r.tipo)) motivos.push("no_es_ticket_o_recibo_pagado");
  if (!r.evidencia.trim() || !r.evidenciaEmpresa.trim()) motivos.push("falta_evidencia");
  if (empresaEvaluada === "desconocida" || !config.empresas.includes(empresaEvaluada)) motivos.push("empresa_no_habilitada_o_ambigua");
  if (!fechaValida(r.fecha)) motivos.push("fecha_invalida");
  if (!/^[A-Z]{3}$/.test(r.moneda)) motivos.push("moneda_invalida");
  if (!r.proveedor.trim() || !r.concepto.trim()) motivos.push("datos_incompletos");
  if (!e.consultasCompletas) motivos.push("verificacion_incompleta");
  if (e.duplicados.length) motivos.push("posible_duplicado");
  if (!e.contacto?.id) motivos.push("proveedor_no_encontrado");
  if (!e.cuenta?.id) motivos.push("cuenta_contable_no_verificada");
  if (!e.permiteTicket) motivos.push(e.motivoTipoDocumento ?? "tipo_ticket_no_soportado");
  if (r.fuente !== "cuerpo" && !c.adjuntos.some(x => x.id === r.fuente)) motivos.push("fuente_inexistente");
  if (a.recibos.filter(x => x.fuente === r.fuente).length !== 1) motivos.push("varios_gastos_en_misma_fuente");
  let esperado = 0;
  let convertido = false;
  let tolerancia = 0;
  try {
    ({ esperado, convertido, tolerancia } = datosMonto(r));
  } catch { motivos.push("importe_o_equivalente_invalido"); }
  const candidatos = candidatosMovimientoAuto(r, e);
  const ids = new Set(candidatos.map(m => `${m.cuentaId}/${m.id}`));
  const m = candidatos[0];
  const coincidenciaMontoFechaExacta = candidatos.length === 1 && m.fecha === r.fecha && -m.centimos === esperado;
  const descripcionConfirmaProveedor = candidatos.length === 1 && (proveedorEnDescripcion(r.proveedor, candidatos[0].descripcion) ||
    Boolean(e.contacto?.nombre && proveedorEnDescripcion(e.contacto.nombre, candidatos[0].descripcion)));
  const nombreAproximadoFuerte = e.contacto?.metodo === "aproximado_unico" && (e.contacto.similitud ?? 0) >= 0.5;
  const contactoVerificado = e.contacto?.exacto === true ||
    (e.contacto?.metodo === "aproximado_unico" && (descripcionConfirmaProveedor ||
      (coincidenciaMontoFechaExacta && nombreAproximadoFuerte)));
  if (e.contacto?.id && !contactoVerificado) motivos.push("proveedor_no_verificado");
  const confianzaReforzada = r.confianza === "media" && contactoVerificado && candidatos.length === 1 && ids.size === 1 && descripcionConfirmaProveedor;
  if (r.confianza !== "alta" && !confianzaReforzada) motivos.push("confianza_insuficiente");
  if (candidatos.length !== 1 || ids.size !== 1) motivos.push(candidatos.length ? "movimiento_ambiguo" : "sin_movimiento_exacto");
  if (m && !coincidenciaMontoFechaExacta && !descripcionConfirmaProveedor) motivos.push("coincidencia_aproximada_sin_proveedor_bancario");
  if (m && (!m.id || !m.cuentaId || !m.origen || m.origen === "manual" || m.estado !== "pending" || m.conciliadoCentimos !== 0)) motivos.push("movimiento_no_libre");
  if (motivos.length) return { apto: false, motivos };
  const empresa = empresaEvaluada as EmpresaAuto;
  const fuenteHash = hash(r.fuente === "cuerpo" ? c.cuerpo : c.adjuntos.find(x => x.id === r.fuente)!.data);
  const numero = r.numero?.trim().toUpperCase().replace(/\s+/g, " ");
  const claves = [`fuente:${hash(`${config.buzon}:${c.id}:${r.fuente}`)}`, `archivo:${empresa}:${fuenteHash}`,
    `movimiento:${empresa}:${m.cuentaId}:${m.id}`];
  if (numero && numero !== "00000") claves.push(`documento:${hash(`${empresa}:${e.contacto!.id}:${numero}`)}`);
  const reciboConEmpresa = e.empresaDetectada ? { ...r, empresa: e.empresaDetectada } : r;
  const reciboPlan = confianzaReforzada ? { ...reciboConEmpresa, confianza: "alta" as const } : reciboConEmpresa;
  const evidenciaPlan = confianzaReforzada
    ? { ...e, confianzaReforzada: "contacto_exacto_y_movimiento_unico_con_proveedor" }
    : e;
  return { apto: true, plan: { empresa, contactoId: e.contacto!.id, cuentaId: e.cuenta?.id, recibo: reciboPlan,
    movimiento: m, totalCentimos: -m.centimos, toleranciaCentimos: tolerancia, diferenciaCentimos: -m.centimos - esperado,
    regla: convertido ? "equivalente_explicito_2pct_min_005_max_500" : (-m.centimos === esperado ? "moneda_nativa_exacta" : "moneda_nativa_2pct_min_005_max_500"), claves, fuenteHash,
    correo: { id: c.id, threadId: c.threadId, buzon: config.buzon }, version: VERSION_POLITICA,
    // La decisión ya quedó auditada por separado. La operación durable solo
    // necesita conservar el movimiento elegido, no todo el historial bancario
    // consultado para demostrar que la coincidencia era única.
    evidencia: { ...evidenciaPlan, movimientos: [m] } } };
}

export type EstadoOperacion = "reservada" | "creando" | "creada" | "adjuntando" | "adjuntada" | "conciliando" | "completada" | "incierta" | "rechazada";
export interface OperacionAuto { id: string; revision?: number; plan: PlanAuto; estado: EstadoOperacion; compraId?: string; detalle?: string; pasoIncierto?: EstadoOperacion }
export interface StoreAuto {
  buscarAnalisis(buzon: string, mensajeId: string, huella: string, version: string): Promise<AnalisisAuto | undefined>;
  guardarAnalisis(buzon: string, mensajeId: string, huella: string, version: string, analisis: AnalisisAuto): Promise<void>;
  reservar(plan: PlanAuto): Promise<OperacionAuto>;
  buscarFuente(buzon: string, mensajeId: string, fuente: string): Promise<OperacionAuto | undefined>;
  guardar(op: OperacionAuto): Promise<void>;
  pendientes(buzon: string): Promise<OperacionAuto[]>;
  recuperables(buzon: string, version: string): Promise<OperacionAuto[]>;
  auditar(evento: { buzon: string; mensajeId?: string; tipo: string; datos: unknown }): Promise<void>;
}
export interface ResultadoAuto {
  modo: ModoAuto; revisados: number; completados: number; simulados: number;
  pendientes: Array<{ mensajeId: string; asunto: string; motivos: string[]; detalles?: Array<{
    proveedor: string; empresa: EmpresaAuto | "desconocida"; monto: number; moneda: string;
    contacto?: string; metodoContacto?: string; motivoProveedor?: string; motivos: string[];
  }> }>;
  gastos: Array<{ empresa: EmpresaAuto; id: string; centimos: number; moneda: string }>;
  reparados?: Array<{ empresa: EmpresaAuto; id: string; centimos: number; moneda: string }>;
}

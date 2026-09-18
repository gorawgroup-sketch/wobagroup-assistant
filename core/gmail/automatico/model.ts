import { createHash } from "node:crypto";

export type EmpresaAuto = "WOBA" | "EWORKS" | "Footprint";
export type ModoAuto = "off" | "simulate" | "execute";
export const VERSION_POLITICA = "correo-gastos-v1";
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
  tipo: "ticket" | "factura" | "otro";
  confianza: "alta" | "media" | "baja";
  empresa: EmpresaAuto | "desconocida";
  proveedor: string; numero?: string; fecha: string; moneda: string; monto: number;
  equivalente?: { moneda: string; monto: number };
  concepto: string; persona?: string; viaje?: boolean;
  evidencia: string; evidenciaEmpresa: string;
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
  contacto?: { id: string; nombre: string; exacto: boolean };
  cuenta?: { id: string; evidencia: string };
  duplicados: string[];
  consultasCompletas: boolean;
  movimientos: MovimientoAuto[];
  /** Procedimiento autorizado: compra seguida de conversión manual a ticket. */
  permiteTicket: boolean;
  motivoTipoDocumento?: string;
}
export interface PlanAuto {
  empresa: EmpresaAuto; contactoId: string; cuentaId: string;
  recibo: ReciboAuto; movimiento: MovimientoAuto; totalCentimos: number;
  toleranciaCentimos: number; diferenciaCentimos: number; regla: string;
  claves: string[]; fuenteHash: string; correo: { id: string; threadId: string; buzon: string };
  version: string; evidencia: EvidenciaAuto;
}
export type DecisionAuto = { apto: true; plan: PlanAuto } | { apto: false; motivos: string[] };

/** La clasificación nunca autoriza una escritura sin contrastes deterministas. */
export function evaluarAuto(c: CorreoAuto, a: AnalisisAuto, r: ReciboAuto, e: EvidenciaAuto, config: ConfigAuto): DecisionAuto {
  const motivos: string[] = [];
  if (!a.completo) motivos.push("lectura_incompleta");
  if (r.tipo !== "ticket") motivos.push("no_es_ticket");
  if (r.confianza !== "alta") motivos.push("confianza_insuficiente");
  if (!r.evidencia.trim() || !r.evidenciaEmpresa.trim()) motivos.push("falta_evidencia");
  if (r.empresa === "desconocida" || !config.empresas.includes(r.empresa)) motivos.push("empresa_no_habilitada_o_ambigua");
  if (!fechaValida(r.fecha)) motivos.push("fecha_invalida");
  if (!/^[A-Z]{3}$/.test(r.moneda)) motivos.push("moneda_invalida");
  if (!r.proveedor.trim() || !r.concepto.trim()) motivos.push("datos_incompletos");
  if (!e.consultasCompletas) motivos.push("verificacion_incompleta");
  if (e.duplicados.length) motivos.push("posible_duplicado");
  if (!e.contacto?.id || e.contacto.exacto !== true) motivos.push("proveedor_no_exacto");
  if (!e.cuenta?.id) motivos.push("cuenta_contable_pendiente");
  if (!e.permiteTicket) motivos.push(e.motivoTipoDocumento ?? "tipo_ticket_no_soportado");
  if (r.fuente !== "cuerpo" && !c.adjuntos.some(x => x.id === r.fuente)) motivos.push("fuente_inexistente");
  if (a.recibos.filter(x => x.fuente === r.fuente).length !== 1) motivos.push("varios_gastos_en_misma_fuente");
  let esperado = 0;
  let moneda = r.moneda;
  let convertido = false;
  try {
    esperado = dinero(r.monto);
    if (r.equivalente) {
      esperado = dinero(r.equivalente.monto);
      moneda = r.equivalente.moneda;
      if (!/^[A-Z]{3}$/.test(moneda) || moneda === r.moneda) throw new Error();
      convertido = true;
    }
  } catch { motivos.push("importe_o_equivalente_invalido"); }
  // Reglas ya presentes en el flujo manual: un céntimo; equivalente explícito, 2% / cinco céntimos.
  const tolerancia = convertido ? Math.max(5, Math.round(esperado * 0.02)) : 1;
  const candidatos = e.movimientos.filter(m => m.moneda === moneda && m.fecha === r.fecha &&
    Number.isSafeInteger(m.centimos) && m.centimos < 0 && Math.abs(-m.centimos - esperado) <= tolerancia);
  const ids = new Set(candidatos.map(m => `${m.cuentaId}/${m.id}`));
  if (candidatos.length !== 1 || ids.size !== 1) motivos.push(candidatos.length ? "movimiento_ambiguo" : "sin_movimiento_exacto");
  const m = candidatos[0];
  if (m && (!m.id || !m.cuentaId || !m.origen || m.origen === "manual" || m.estado !== "pending" || m.conciliadoCentimos !== 0)) motivos.push("movimiento_no_libre");
  // Una tolerancia identifica un candidato; no autoriza a alterar el importe original de un recibo.
  // Con equivalente explícito sí se registra la liquidación real, conservando ambos importes.
  if (m && !convertido && -m.centimos !== esperado) motivos.push("diferencia_requiere_revision");
  if (motivos.length) return { apto: false, motivos };
  const empresa = r.empresa as EmpresaAuto;
  const fuenteHash = hash(r.fuente === "cuerpo" ? c.cuerpo : c.adjuntos.find(x => x.id === r.fuente)!.data);
  const numero = r.numero?.trim().toUpperCase().replace(/\s+/g, " ");
  const claves = [`fuente:${hash(`${config.buzon}:${c.id}:${r.fuente}`)}`, `archivo:${empresa}:${fuenteHash}`,
    `movimiento:${empresa}:${m.cuentaId}:${m.id}`];
  if (numero && numero !== "00000") claves.push(`documento:${hash(`${empresa}:${e.contacto!.id}:${numero}`)}`);
  return { apto: true, plan: { empresa, contactoId: e.contacto!.id, cuentaId: e.cuenta!.id, recibo: r,
    movimiento: m, totalCentimos: -m.centimos, toleranciaCentimos: tolerancia, diferenciaCentimos: -m.centimos - esperado,
    regla: convertido ? "equivalente_explicito_2pct_min_005" : "moneda_nativa_001", claves, fuenteHash,
    correo: { id: c.id, threadId: c.threadId, buzon: config.buzon }, version: VERSION_POLITICA,
    // La decisión ya quedó auditada por separado. La operación durable solo
    // necesita conservar el movimiento elegido, no todo el historial bancario
    // consultado para demostrar que la coincidencia era única.
    evidencia: { ...e, movimientos: [m] } } };
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
  auditar(evento: { buzon: string; mensajeId?: string; tipo: string; datos: unknown }): Promise<void>;
}
export interface ResultadoAuto {
  modo: ModoAuto; revisados: number; completados: number; simulados: number;
  pendientes: Array<{ mensajeId: string; asunto: string; motivos: string[] }>;
  gastos: Array<{ empresa: EmpresaAuto; id: string; centimos: number; moneda: string }>;
}

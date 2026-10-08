import { hash, type AnalisisAuto, type CorreoAuto, type EvidenciaAuto, type OperacionAuto, type PlanAuto, type ReciboAuto, type StoreAuto } from "../model";
import { ServicioCorreoAutomatico, type PuertoAutomatico } from "../service";
import { configFixture, evidenciaFixture } from "../fixtures";

/**
 * Banco de casos reales (Carlos, 08-10-2026, punto 2 del plan contra la recurrencia): cada correo que nos bloqueó queda aquí,
 * anonimizado, con el informe que DEBE salir. El modelo de IA se sustituye por el análisis que dio en vivo; todo lo demás
 * (recuperación de operaciones, evaluación, informe) es el código real. Un PR que vuelva a disfrazar una causa rompe el CI.
 */
export interface CasoReal {
  nombre: string;
  /** Qué pasó en vivo y cuándo, para quien lea el fallo. */
  origen: string;
  correo: CorreoAuto;
  /** Análisis que devolvió el modelo; o un error si el análisis no se pudo hacer (tope de IA, red). */
  analisis: AnalisisAuto | (() => never);
  evidencia?: EvidenciaAuto;
  operacionesPrevias?: OperacionAuto[];
  /** El correo no está en la bandeja (ya leído): solo se revisa su operación anterior. */
  correoYaLeido?: boolean;
  /** Holded no confirma la conciliación al releerla (p. ej. quedó «partial»). */
  conciliacionNoVerificable?: boolean;
  /** Mensaje con el que falla la conciliación en Holded (el flujo real lanza «Conciliación no confirmada al 100 %: partial.»). */
  conciliarFalla?: string;
  espera: RegExp[];
  noEspera: RegExp[];
}

export function correoCaso(id: string, extra: Partial<CorreoAuto> = {}): CorreoAuto {
  return { id, threadId: `t-${id}`, de: "Remitente <remitente@example.com>", asunto: `Caso ${id}`, fecha: "2026-10-06", recibidoEn: 1,
    cuerpo: `Cuerpo del correo ${id}`, contextoHilo: "", adjuntos: [], huella: hash(id), ...extra };
}

export function reciboCaso(extra: Partial<ReciboAuto> = {}): ReciboAuto {
  return { fuente: "cuerpo", tipo: "ticket", confianza: "alta", empresa: "Footprint", proveedor: "Proveedor", fecha: "2026-10-06",
    moneda: "EUR", monto: 20, concepto: "Consumo", evidencia: "Total 20 EUR", evidenciaEmpresa: "Footprint en el documento", ...extra };
}

/** Una operación guardada por una pasada anterior (misma forma que persiste el store real). */
export function operacionPrevia(o: { id: string; correo: CorreoAuto; recibo: ReciboAuto; estado: OperacionAuto["estado"]; version: string;
  compraId?: string; detalle?: string; pasoIncierto?: OperacionAuto["estado"]; evidencia?: EvidenciaAuto }): OperacionAuto {
  const evidencia = o.evidencia ?? evidenciaFixture();
  const plan: PlanAuto = { empresa: o.recibo.empresa as PlanAuto["empresa"], contactoId: evidencia.contacto?.id ?? "p1", cuentaId: evidencia.cuenta?.id,
    recibo: o.recibo, movimiento: evidencia.movimientos[0], totalCentimos: Math.round(o.recibo.monto * 100), toleranciaCentimos: 0,
    diferenciaCentimos: 0, regla: "caso-real", claves: [`${configFixture.buzon}:${o.correo.id}:${o.recibo.fuente}`], fuenteHash: hash(o.correo.id),
    correo: { id: o.correo.id, threadId: o.correo.threadId, buzon: configFixture.buzon }, version: o.version, evidencia };
  return { id: o.id, plan, estado: o.estado, compraId: o.compraId, detalle: o.detalle, pasoIncierto: o.pasoIncierto };
}

export function ejecutarCaso(caso: CasoReal) {
  const copiar = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const ops = new Map<string, OperacionAuto>((caso.operacionesPrevias ?? []).map((op) => [op.id, copiar(op)]));
  let cuenta = ops.size;
  const analisisGuardados = new Map<string, AnalisisAuto>();
  const store: StoreAuto = {
    buscarAnalisis: async (b, m, h, v) => copiar(analisisGuardados.get(`${b}:${m}:${h}:${v}`)),
    guardarAnalisis: async (b, m, h, v, a) => { analisisGuardados.set(`${b}:${m}:${h}:${v}`, copiar(a)); },
    buscarFuente: async (_b, m, f) => copiar([...ops.values()].find((o) => o.plan.correo.id === m && o.plan.recibo.fuente === f && o.estado !== "rechazada")),
    pendientes: async () => copiar([...ops.values()].filter((o) => !["completada", "rechazada"].includes(o.estado))),
    recuperables: async (_b, version) => copiar([...ops.values()].filter((o) => !["completada", "rechazada"].includes(o.estado) ||
      (o.estado === "completada" && Boolean(o.compraId) && o.plan.version !== version))),
    reservar: async (plan) => { const op: OperacionAuto = { id: String(++cuenta), plan, estado: "reservada" }; ops.set(op.id, copiar(op)); return op; },
    guardar: async (op) => { ops.set(op.id, copiar(op)); },
    auditar: async () => {},
  };
  const correos = caso.correoYaLeido ? [] : [caso.correo];
  const puerto: PuertoAutomatico = {
    listar: async () => correos, obtener: async (id) => (id === caso.correo.id ? caso.correo : undefined),
    reservadoManualmente: async () => false,
    analizar: async () => (typeof caso.analisis === "function" ? caso.analisis() : copiar(caso.analisis)),
    evidencias: async () => copiar(caso.evidencia ?? evidenciaFixture()),
    crear: async () => "compra-caso", recuperarCreacion: async () => undefined, verificarCreacion: async () => true,
    prepararAdjunto: async (op) => { op.plan.soporteHash = hash("pdf"); op.plan.soporteNombre = "comprobante.pdf"; op.plan.soporteMime = "application/pdf"; },
    adjuntar: async () => {}, verificarAdjunto: async () => true,
    conciliar: async () => { if (caso.conciliarFalla) throw new Error(caso.conciliarFalla); }, verificarConciliacion: async () => !caso.conciliacionNoVerificable,
    marcarResuelto: async () => {}, registrarFinalizada: async () => {},
    permitidoAhora: () => true, ejecutarProtegido: async (_op, f) => f(),
  };
  return { service: new ServicioCorreoAutomatico(store, puerto), ops };
}

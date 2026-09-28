import { describirFaltanteCierre, evaluarEvidenciaCierre, type ComprobacionCierre, type HechosCierre } from "./cierreConEvidencia";
import { VERSION_POLITICA, type AnalisisAuto, type OperacionAuto } from "./model";

/**
 * Qué hacer con un correo que tiene operaciones automáticas anteriores cuando el operador lo revisa
 * a mano. Antes bastaba una operación no terminal para rechazar la revisión («pendiente de verificar,
 * no se repetirán escrituras»), y el proceso automático a su vez se apartaba de los correos que la
 * revisión manual tenía reservados: ninguno de los dos podía cerrar la operación (bloqueo mutuo,
 * JetBlue 2026-09-28). Aquí se sale del bloqueo con pruebas leídas de Holded, sin repetir escrituras.
 */

/** Margen para no cerrar una operación que otro proceso está ejecutando en este momento. */
export const REPOSO_MINIMO_MS = 5 * 60_000;

export interface OperacionConEdad { op: OperacionAuto; actualizadaEn: number }

export interface DepsOperacionAnterior {
  /** Todas las operaciones del hilo que no fueron rechazadas. */
  operacionesDeHilo(threadId: string): Promise<OperacionConEdad[]>;
  analisisDeMensaje(mensajeId: string): Promise<AnalisisAuto | undefined>;
  /** Solo lecturas de Holded. */
  leerHechos(op: OperacionAuto): Promise<HechosCierre>;
  guardar(op: OperacionAuto): Promise<void>;
  auditar(evento: { mensajeId?: string; tipo: string; datos: unknown }): Promise<void>;
  registrarFinalizada(op: OperacionAuto): Promise<void>;
  ahora(): number;
}

export interface GastoYaRegistrado {
  empresa: string; proveedor: string; monto: number; moneda: string; compraId: string;
}

export interface BloqueoOperacion {
  id: string;
  estado: OperacionAuto["estado"];
  compraId?: string;
  /** Lo que Holded todavía no refleja, en lenguaje llano. */
  faltan: string[];
  detalle?: string;
}

export type ResultadoOperacionAnterior =
  | { tipo: "libre" }
  | { tipo: "ya_registrado"; gastos: GastoYaRegistrado[]; cerradas: number }
  | { tipo: "bloqueada"; motivo: "en_curso" | "sin_pruebas" | "lectura_fallida"; operaciones: BloqueoOperacion[] };

const esTerminal = (op: OperacionAuto) => op.estado === "completada" || op.estado === "rechazada";

/** El análisis del correo demuestra que TODO lo que había que registrar ya tiene su operación completada. */
function recibosCubiertos(analisis: AnalisisAuto | undefined, completadas: OperacionAuto[]): boolean {
  if (!analisis || !analisis.completo || analisis.otrasAcciones || !analisis.recibos.length) return false;
  return analisis.recibos.every(recibo => completadas.some(op => op.plan.recibo.fuente === recibo.fuente));
}

export type IntentoCierre =
  | { cerrada: true }
  | { cerrada: false; motivo: "en_curso" | "sin_pruebas" | "lectura_fallida"; bloqueo: BloqueoOperacion };

/** Holded ya no encuentra el recurso (compra borrada, cuenta archivada): es un hecho, no un fallo transitorio. */
const esRecursoInexistente = (error: unknown): boolean =>
  /Consulta Holded falló \((?:404|410)\)/.test(error instanceof Error ? error.message : String(error));

/**
 * Comprueba en Holded una operación sin estado terminal y, solo si TODO lo que debía escribir ya está, la cierra
 * como completada. Nunca escribe en Holded. `reposoMs` = 0 cuando el llamador ya tiene el buzón bajo su coordinador.
 */
export async function intentarCerrarOperacion(
  op: OperacionAuto,
  actualizadaEn: number,
  deps: DepsOperacionAnterior,
  reposoMs = REPOSO_MINIMO_MS
): Promise<IntentoCierre> {
  const base: BloqueoOperacion = { id: op.id, estado: op.estado, compraId: op.compraId, faltan: [], detalle: op.detalle };
  const bloqueo = (motivo: "en_curso" | "sin_pruebas" | "lectura_fallida", faltan: string[]): IntentoCierre =>
    ({ cerrada: false, motivo, bloqueo: { ...base, faltan } });
  if (deps.ahora() - actualizadaEn < reposoMs) {
    return bloqueo("en_curso", ["sigue en curso (última actividad hace menos de 5 minutos)"]);
  }
  let hechos: HechosCierre;
  try { hechos = await deps.leerHechos(op); }
  catch (error) {
    if (esRecursoInexistente(error)) {
      return bloqueo("sin_pruebas", ["Holded ya no encuentra la compra o la cuenta bancaria de esta operación"]);
    }
    // Distinguir «no pude leer Holded» de «Holded dice que falta algo»: lo primero se reintenta sin más.
    console.error("[correo-auto] No se pudo leer Holded para verificar la operación anterior:", {
      operacion: op.id, error: error instanceof Error ? error.message : String(error) });
    return bloqueo("lectura_fallida", ["no pude consultar Holded para comprobarlo"]);
  }
  const evaluacion = evaluarEvidenciaCierre(op, hechos);
  if (evaluacion.veredicto !== "completa") {
    return bloqueo("sin_pruebas", evaluacion.faltan.map((k: ComprobacionCierre) => describirFaltanteCierre(k)));
  }
  const estadoPrevio = { estado: op.estado, paso: op.pasoIncierto, detalle: op.detalle, version: op.plan.version };
  try {
    // Primero el registro del gasto del correo (Sheets, idempotente): si falla, la operación sigue abierta y se
    // reintenta; cerrada primero, el cambio de versión impediría volver a intentarlo.
    await deps.registrarFinalizada(op);
    op.estado = "completada";
    op.pasoIncierto = undefined;
    op.detalle = "Cerrada con prueba leída de Holded: compra propia, pagada, con comprobante y movimiento conciliado" +
      (evaluacion.saldoResidualCentimos ? ` (saldo residual de ${evaluacion.saldoResidualCentimos} céntimo(s) dentro de la tolerancia del plan).` : ".");
    // La versión vigente evita que la próxima pasada la trate como «reparación de política anterior» y edite
    // una compra que ya está bien o que alguien corrigió a mano.
    op.plan.version = VERSION_POLITICA;
    await deps.guardar(op);
  } catch (error) {
    // Otra ejecución modificó la operación entre la lectura y el guardado, o el registro falló: no se fuerza nada.
    console.error("[correo-auto] No se pudo cerrar la operación con evidencia:", {
      operacion: op.id, error: error instanceof Error ? error.message : String(error) });
    return bloqueo("lectura_fallida", ["no pude dejar constancia del cierre; se reintentará"]);
  }
  await deps.auditar({ mensajeId: op.plan.correo.id, tipo: "cierre_por_evidencia", datos: {
    operacion: op.id, compraId: op.compraId, previo: estadoPrevio, comprobaciones: evaluacion.comprobaciones,
    saldoResidualCentimos: evaluacion.saldoResidualCentimos, origen: "revision_de_correo" } })
    .catch(error => console.error("[correo-auto] Operación cerrada; no se pudo auditar el cierre:", error));
  return { cerrada: true };
}

export async function resolverOperacionAnterior(
  threadId: string,
  mensajeId: string | undefined,
  deps: DepsOperacionAnterior
): Promise<ResultadoOperacionAnterior> {
  let operaciones = await deps.operacionesDeHilo(threadId);
  const bloqueos: BloqueoOperacion[] = [];
  let motivo: Extract<ResultadoOperacionAnterior, { tipo: "bloqueada" }>["motivo"] = "sin_pruebas";
  let cerradas = 0;

  for (const { op, actualizadaEn } of operaciones.filter(x => !esTerminal(x.op))) {
    const intento = await intentarCerrarOperacion(op, actualizadaEn, deps);
    if (intento.cerrada) { cerradas++; continue; }
    if (motivo !== "en_curso" && (intento.motivo === "en_curso" || motivo === "sin_pruebas")) motivo = intento.motivo;
    bloqueos.push(intento.bloqueo);
  }
  if (bloqueos.length) return { tipo: "bloqueada", motivo, operaciones: bloqueos };

  if (cerradas) operaciones = await deps.operacionesDeHilo(threadId);
  const completadas = operaciones.map(x => x.op).filter(op => op.estado === "completada" && op.compraId &&
    (!mensajeId || op.plan.correo.id === mensajeId));
  if (!completadas.length || !mensajeId) return { tipo: "libre" };
  if (!recibosCubiertos(await deps.analisisDeMensaje(mensajeId), completadas)) return { tipo: "libre" };
  return {
    tipo: "ya_registrado",
    cerradas,
    gastos: completadas.map(op => ({ empresa: op.plan.empresa, proveedor: op.plan.recibo.proveedor,
      monto: op.plan.recibo.monto, moneda: op.plan.recibo.moneda, compraId: op.compraId! })),
  };
}

/** Texto para el operador cuando la operación anterior no se pudo cerrar. */
export function mensajeOperacionBloqueada(r: Extract<ResultadoOperacionAnterior, { tipo: "bloqueada" }>): string {
  const cabecera = r.motivo === "en_curso"
    ? "Este correo tiene una operación automática que sigue en curso; espera unos minutos."
    : r.motivo === "lectura_fallida"
      ? "Este correo tiene una operación automática sin cerrar y no pude comprobar Holded ahora mismo; inténtalo de nuevo en un momento."
      : "Este correo tiene una operación automática sin cerrar y Holded no muestra todavía el resultado completo.";
  const lineas = r.operaciones.map(o => {
    const id = o.id.slice(0, 8);
    const compra = o.compraId ? `compra ${o.compraId}` : "sin compra registrada";
    return `• Operación ${id}… (${o.estado}, ${compra}): ${o.faltan.join("; ") || "sin datos suficientes"}.`;
  });
  return [cabecera, ...lineas, "No se repetirán escrituras."].join("\n");
}

/** Texto para el chat cuando el correo ya estaba registrado y conciliado. */
export function mensajeYaRegistrado(r: Extract<ResultadoOperacionAnterior, { tipo: "ya_registrado" }>, asunto: string): string {
  const gastos = r.gastos.map(g => `• ${g.empresa} · ${g.proveedor} · ${g.monto} ${g.moneda} · compra ${g.compraId}`);
  return [
    `✅ «${asunto}» ya estaba registrado y conciliado en Holded${r.cerradas ? "; cerré la operación anterior que había quedado sin verificar" : ""}.`,
    ...gastos,
    "No creé ni concilié nada nuevo.",
  ].join("\n");
}

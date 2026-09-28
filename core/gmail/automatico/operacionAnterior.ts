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

export async function resolverOperacionAnterior(
  threadId: string,
  mensajeId: string | undefined,
  deps: DepsOperacionAnterior
): Promise<ResultadoOperacionAnterior> {
  let operaciones = await deps.operacionesDeHilo(threadId);
  const pendientes = operaciones.filter(x => !esTerminal(x.op));
  const bloqueos: BloqueoOperacion[] = [];
  let motivo: Extract<ResultadoOperacionAnterior, { tipo: "bloqueada" }>["motivo"] = "sin_pruebas";
  let cerradas = 0;

  for (const { op, actualizadaEn } of pendientes) {
    const base: BloqueoOperacion = { id: op.id, estado: op.estado, compraId: op.compraId, faltan: [], detalle: op.detalle };
    if (deps.ahora() - actualizadaEn < REPOSO_MINIMO_MS) {
      motivo = "en_curso";
      bloqueos.push({ ...base, faltan: ["sigue en curso (última actividad hace menos de 5 minutos)"] });
      continue;
    }
    let hechos: HechosCierre;
    try { hechos = await deps.leerHechos(op); }
    catch (error) {
      // Distinguir «no pude leer Holded» de «Holded dice que falta algo»: lo primero se reintenta sin más.
      console.error("[correo-auto] No se pudo leer Holded para verificar la operación anterior:", {
        operacion: op.id, error: error instanceof Error ? error.message : String(error) });
      if (motivo !== "en_curso") motivo = "lectura_fallida";
      bloqueos.push({ ...base, faltan: ["no pude consultar Holded para comprobarlo"] });
      continue;
    }
    const evaluacion = evaluarEvidenciaCierre(op, hechos);
    if (evaluacion.veredicto !== "completa") {
      bloqueos.push({ ...base, faltan: evaluacion.faltan.map((k: ComprobacionCierre) => describirFaltanteCierre(k)) });
      continue;
    }
    try {
      const estadoPrevio = { estado: op.estado, paso: op.pasoIncierto, detalle: op.detalle, version: op.plan.version };
      op.estado = "completada";
      op.pasoIncierto = undefined;
      op.detalle = "Cerrada con prueba leída de Holded: compra propia, pagada, con comprobante y movimiento conciliado.";
      // La versión vigente evita que la próxima pasada la trate como «reparación de política anterior» y edite
      // una compra que ya está bien o que alguien corrigió a mano.
      op.plan.version = VERSION_POLITICA;
      await deps.guardar(op);
      await deps.auditar({ mensajeId: op.plan.correo.id, tipo: "cierre_por_evidencia", datos: {
        operacion: op.id, compraId: op.compraId, previo: estadoPrevio, comprobaciones: evaluacion.comprobaciones,
        origen: "revision_manual_del_correo" } });
      await deps.registrarFinalizada(op).catch(error =>
        console.error("[correo-auto] Operación cerrada, pero no se pudo registrar el gasto del correo:", error));
      cerradas++;
    } catch (error) {
      // Otra ejecución modificó la operación entre la lectura y el guardado: no se fuerza nada.
      console.error("[correo-auto] No se pudo cerrar la operación con evidencia:", {
        operacion: op.id, error: error instanceof Error ? error.message : String(error) });
      if (motivo !== "en_curso") motivo = "lectura_fallida";
      bloqueos.push({ ...base, faltan: ["otra ejecución la modificó mientras la comprobaba"] });
    }
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

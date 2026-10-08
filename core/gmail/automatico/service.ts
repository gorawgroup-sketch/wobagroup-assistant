import { esRemitenteDelGrupo } from "../../gastos/remitenteDelGrupo";
import { completarEquivalenteExplicito } from "./equivalenteExplicito";
import { candidatosMovimientoAuto, evaluarAuto, type AnalisisAuto, type ConfigAuto, type CorreoAuto, type EvidenciaAuto,
  nombresProveedorCompatibles, type OperacionAuto, type PlanAuto, type ReciboAuto, type ResultadoAuto,
  type StoreAuto, VERSION_ANALISIS, VERSION_POLITICA } from "./model";
import { mapearConConcurrencia } from "../../utils/mapearConConcurrencia";
import { conTiempoMaximo } from "../../utils/asyncTimeout";
import { UsoApiNoAutorizadoError } from "../../ai/policy";

export interface PuertoAutomatico {
  listar(): Promise<CorreoAuto[]>;
  obtener(mensajeId: string, threadId: string): Promise<CorreoAuto | undefined>;
  reservadoManualmente(threadId: string): Promise<boolean>;
  analizar(correo: CorreoAuto): Promise<AnalisisAuto>;
  evidencias(correo: CorreoAuto, recibo: ReciboAuto): Promise<EvidenciaAuto>;
  crear(op: OperacionAuto): Promise<string>;
  recuperarCreacion(op: OperacionAuto): Promise<string | undefined>;
  registrarFinalizada(op: OperacionAuto): Promise<void>;
  verificarCreacion(op: OperacionAuto): Promise<boolean>;
  /** Construye y fija de forma durable el archivo contable antes de iniciar su carga. */
  prepararAdjunto(op: OperacionAuto, correo: CorreoAuto): Promise<void>;
  adjuntar(op: OperacionAuto, correo: CorreoAuto): Promise<void>;
  verificarAdjunto(op: OperacionAuto): Promise<boolean>;
  conciliar(op: OperacionAuto): Promise<void>;
  verificarConciliacion(op: OperacionAuto): Promise<boolean>;
  /** Marca leído y etiqueta solo el mensaje cuya creación, soporte y conciliación ya fueron verificados. */
  marcarResuelto(correo: CorreoAuto): Promise<void>;
  permitidoAhora(op: OperacionAuto): boolean;
  ejecutarProtegido<T>(op: OperacionAuto, tarea: () => Promise<T>): Promise<T>;
  /**
   * Última salida de una operación que la verificación estricta no pudo dar por terminada: la cierra solo si Holded
   * demuestra (por lectura) que todo lo que debía escribir ya está. Nunca escribe en Holded. Opcional.
   */
  cerrarConEvidencia?(op: OperacionAuto): Promise<boolean>;
}
const mensajeError = (e: unknown) => e instanceof Error ? e.message : "Error de verificación";
/**
 * ¿La relectura de un correo da el MISMO recibo que usó la operación anterior? Misma parte (fuente), misma fecha, misma moneda contable e
 * importe dentro de la tolerancia. Dos precisiones (caso real 08-10-2026: cinco operaciones en moneda extranjera atascadas con «el recibo no
 * coincide» aunque importe y fecha eran idénticos):
 *  - El total del plan (`totalCentimos`) es el importe del MOVIMIENTO bancario: solo es comparable con el recibo si están en la misma moneda
 *    (24,20 USD del recibo frente a 20,88 EUR del cargo nunca coinciden y no tienen por qué).
 *  - La empresa de la operación ya está fijada por su plan; una relectura que no la sabe («desconocida») no la contradice. Una relectura que
 *    nombra OTRA empresa distinta sí bloquea.
 */
export function motivosDeNoCorrespondencia(anterior: ReciboAuto, actual: ReciboAuto, op: OperacionAuto): string[] {
  const centimos = (monto: number) => Math.round(monto * 100);
  const tolerancia = Math.max(0, op.plan.toleranciaCentimos);
  const motivos: string[] = [];
  if (actual.fuente !== anterior.fuente) motivos.push("otra parte del correo");
  if (!(actual.empresa === op.plan.empresa || actual.empresa === "desconocida")) motivos.push(`empresa ${actual.empresa} en vez de ${op.plan.empresa}`);
  if (actual.fecha !== anterior.fecha) motivos.push("otra fecha");
  // El importe IMPRESO es lo que identifica al recibo. El `equivalente` del plan puede venir de la búsqueda bancaria (evidencia),
  // no del correo: la relectura no lo trae y compararlo ahí daba «340 MXN» contra «EUR» (caso real 08-10-2026: Antaris, Xue Cafe).
  if (actual.moneda !== anterior.moneda || Math.abs(centimos(actual.monto) - centimos(anterior.monto)) > tolerancia) motivos.push("otro importe impreso");
  // Si lo releído (impreso o equivalente) está en la moneda del movimiento, tiene que cuadrar con el total del plan; en otra moneda
  // no son comparables (24,20 USD del recibo frente a 20,88 EUR del cargo nunca coinciden y no tienen por qué).
  const contable = actual.equivalente ?? { monto: actual.monto, moneda: actual.moneda };
  if (contable.moneda === op.plan.movimiento.moneda && Math.abs(centimos(contable.monto) - op.plan.totalCentimos) > tolerancia) {
    motivos.push("no cuadra con el cargo del plan");
  }
  // Con las dos lecturas en la misma moneda contable, también deben coincidir entre sí.
  if (anterior.equivalente && actual.equivalente && anterior.equivalente.moneda === actual.equivalente.moneda &&
    Math.abs(centimos(actual.equivalente.monto) - centimos(anterior.equivalente.monto)) > tolerancia) motivos.push("otro equivalente");
  return motivos;
}

export function reciboCorrespondeALaOperacion(anterior: ReciboAuto, actual: ReciboAuto, op: OperacionAuto): boolean {
  return motivosDeNoCorrespondencia(anterior, actual, op).length === 0;
}

/**
 * Un análisis COMPLETO guardado se reutiliza siempre (un mensaje de Gmail es inmutable). Uno INCOMPLETO no: se guardó en un mal momento
 * (adjunto que no se pudo leer entonces, fallo del modelo, tope de coste…) y reutilizarlo para siempre dejaba el correo atascado en
 * «el analizador no dio por completa la lectura» aunque ahora se lea bien (caso real, 2026-10-08: el recibo de Anthropic de 24,20 USD salía
 * incompleto en la revisión y completo al releerlo). Se reintenta, pero no más de una vez cada 2 h para no gastar IA en lo que sigue
 * siendo ilegible; los guardados sin marca de fecha (anteriores a este cambio) se reintentan una vez.
 */
export const ESPERA_REINTENTO_ANALISIS_INCOMPLETO_MS = 2 * 60 * 60_000;
export function analisisReutilizable(guardado: AnalisisAuto | undefined, ahora = Date.now()): AnalisisAuto | undefined {
  if (!guardado) return undefined;
  if (guardado.completo) return guardado;
  return typeof guardado.analizadoEn === "number" && ahora - guardado.analizadoEn < ESPERA_REINTENTO_ANALISIS_INCOMPLETO_MS ? guardado : undefined;
}

export function diagnosticoAnalisis(error: unknown): string {
  if (!(error instanceof Error)) return "Error no estructurado";
  // No incluir cuerpos de correos ni respuestas remotas en logs.
  const e = error as Error & { status?: number; code?: string };
  const validacion = /^(Análisis|Datos extraídos|Equivalente|Texto extraído|Contexto de viaje|Motivo manual)/.test(e.message);
  return [e.name, Number.isInteger(e.status) ? `HTTP ${e.status}` : "",
    e.code && /^[A-Z0-9_]{1,60}$/i.test(e.code) ? e.code : "",
    validacion ? e.message.slice(0, 160).replace(/[\r\n]/g, " ") : ""].filter(Boolean).join(": ");
}
function motivoFalloAnalisis(error: unknown): string {
  if (error instanceof UsoApiNoAutorizadoError) {
    if (["limite_diario_alcanzado", "limite_mensual_alcanzado", "limite_diario_proceso_alcanzado"]
      .includes(error.motivo)) return "revision_pospuesta_por_limite_de_ia";
    return "analisis_ia_no_disponible";
  }
  const nombre = error instanceof Error ? error.name : "Error";
  if (/TiempoMaximo|Timeout|APIConnection|RateLimit/i.test(nombre)) return "fallo_temporal_analisis_ia";
  return "fallo_tecnico_analisis_ia";
}
type ProgresoRevision = { fase: "analisis" | "recuperacion" | "verificacion"; completados: number; total: number };
type CorreoPreparado = { correo: CorreoAuto; analisis?: AnalisisAuto; motivos: string[] };

/**
 * Ordena el presupuesto limitado de análisis nuevos sin hacer otra llamada a
 * Gmail ni a IA. La puntuación usa únicamente el mensaje que GmailAuto ya
 * leyó por completo. No decide si se crea un gasto: solo procura que los
 * comprobantes probables lleguen antes al análisis caro; evaluarAuto conserva
 * todas las barreras deterministas antes de cualquier escritura.
 */
export function prioridadAnalisisAutomatico(correo: CorreoAuto): number {
  const asunto = correo.asunto.toLowerCase();
  const texto = `${correo.asunto}\n${correo.cuerpo.slice(0, 40_000)}`.toLowerCase();
  let puntos = 0;
  if (correo.adjuntos.some(adjunto =>
    /^(application\/pdf|image\/)/i.test(adjunto.mime) ||
    /\.(pdf|jpe?g|png|heic|webp)$/i.test(adjunto.nombre)
  )) puntos += 100;
  if (/\b(ticket|recibo|factura|invoice|receipt|comprobante)\b/i.test(texto)) puntos += 50;
  if (/(?:\b\d{1,6}(?:[.,]\d{1,2})?\s*(?:eur|usd|cop|mxn|gbp)\b|[$€£]\s*\d)/i.test(texto)) puntos += 30;
  if (/\b(total|importe|pagad[oa]|paid|visa|mastercard|revolut|compra|purchase)\b/i.test(texto)) puntos += 10;
  if (/^(?:re|fw|fwd):/i.test(asunto)) puntos += 1;
  return puntos;
}

export class ServicioCorreoAutomatico {
  constructor(private readonly store: StoreAuto, private readonly puerto: PuertoAutomatico,
    private readonly opciones: { concurrenciaAnalisis?: number; fechaLimite?: number;
      maxAnalisisNuevos?: number;
      /**
       * Cancelación cooperativa: cuando devuelve true (el proceso recibió SIGTERM por un
       * despliegue), la revisión no inicia análisis, consultas ni escrituras nuevas y termina en el
       * siguiente punto de control — los mismos donde ya se respeta `fechaLimite`. Las operaciones
       * durables que ya estaban en vuelo (creando/adjuntando/conciliando) sí se cierran por
       * lectura, porque eso no repite ningún POST. Caso real 2026-09-28: sin esto, un redeploy
       * mataba /revisarcorreo en «39/50» sin aviso ni reanudación.
       */
      detener?: () => boolean;
      progreso?: (p: ProgresoRevision) => void | Promise<void> } = {}) {}

  private interrumpida = false;

  /** Motivo por el que NO debe empezar trabajo nuevo ahora, o undefined si puede seguir. */
  private motivoPospuesto(): "revision_pospuesta_por_reinicio" | "revision_pospuesta_por_limite_de_tiempo" | undefined {
    if (this.opciones.detener?.()) {
      this.interrumpida = true;
      return "revision_pospuesta_por_reinicio";
    }
    if (this.opciones.fechaLimite && Date.now() >= this.opciones.fechaLimite) return "revision_pospuesta_por_limite_de_tiempo";
    return undefined;
  }

  private async prepararCorreo(
    config: ConfigAuto,
    correo: CorreoAuto,
    presupuesto: { disponibles: number }
  ): Promise<CorreoPreparado> {
    try {
      if (await this.puerto.reservadoManualmente(correo.threadId)) {
        return { correo, motivos: ["revision_manual_o_autorespuesta_activa"] };
      }
      let analisis = analisisReutilizable(await this.store.buscarAnalisis(config.buzon, correo.id, correo.huella, VERSION_ANALISIS));
      if (!analisis) {
        const pospuesto = this.motivoPospuesto();
        if (pospuesto) return { correo, motivos: [pospuesto] };
        if (presupuesto.disponibles <= 0) {
          return { correo, motivos: ["revision_pospuesta_por_limite_de_coste"] };
        }
        presupuesto.disponibles--;
        analisis = { ...(await this.puerto.analizar(correo)), analizadoEn: Date.now() };
        await this.store.guardarAnalisis(config.buzon, correo.id, correo.huella, VERSION_ANALISIS, analisis);
        await this.store.auditar({ buzon: config.buzon, mensajeId: correo.id, tipo: "analisis",
          datos: { huella: correo.huella, resumen: analisis.resumen, recibos: analisis.recibos, completo: analisis.completo,
            otrasAcciones: analisis.otrasAcciones, origen: "observacion_automatica_no_confirmada" } });
      }
      return { correo, analisis: completarEquivalenteExplicito(analisis, correo.asunto, esRemitenteDelGrupo(correo.de)), motivos: [] };
    } catch (error) {
      const motivo = motivoFalloAnalisis(error);
      console.warn("[correo-auto] No se completó el análisis del mensaje:", {
        mensajeId: correo.id,
        motivo,
        error: diagnosticoAnalisis(error),
      });
      await this.store.auditar({ buzon: config.buzon, mensajeId: correo.id, tipo: "analisis_no_completado",
        datos: { motivo, error: diagnosticoAnalisis(error) } }).catch(auditError =>
        console.warn("[correo-auto] No se pudo auditar el fallo del analizador:",
          auditError instanceof Error ? auditError.name : "Error")
      );
      return { correo, motivos: [motivo] };
    }
  }

  private async analizarParaRecuperacion(config: ConfigAuto, correo: CorreoAuto): Promise<AnalisisAuto> {
    let analisis = analisisReutilizable(await this.store.buscarAnalisis(config.buzon, correo.id, correo.huella, VERSION_ANALISIS));
    if (!analisis) {
      analisis = { ...(await this.puerto.analizar(correo)), analizadoEn: Date.now() };
      await this.store.guardarAnalisis(config.buzon, correo.id, correo.huella, VERSION_ANALISIS, analisis);
      await this.store.auditar({ buzon: config.buzon, mensajeId: correo.id, tipo: "reanalisis_reparacion",
        datos: { huella: correo.huella, resumen: analisis.resumen, recibos: analisis.recibos,
          completo: analisis.completo, origen: "relectura_de_operacion_anterior" } });
    }
    return analisis;
  }

  private reciboCorrespondeALaMismaOperacion(anterior: ReciboAuto, actual: ReciboAuto, op: OperacionAuto): boolean {
    return reciboCorrespondeALaOperacion(anterior, actual, op);
  }

  private contactoSeguroParaReparar(recibo: ReciboAuto, evidencia: EvidenciaAuto): boolean {
    const contacto = evidencia.contacto;
    if (!contacto?.id) return false;
    if (contacto.metodo === "nombre_exacto" || contacto.metodo === "nombre_equivalente") return true;
    // Compatibilidad con puertos antiguos que solo informaban `exacto`: aun así se
    // exige que el nombre leído en Holded corresponda al proveedor del comprobante.
    if (contacto.exacto && nombresProveedorCompatibles(contacto.nombre, recibo.proveedor)) return true;
    return (contacto.metodo === "aproximado_unico" || contacto.metodo === "alias_confirmado") &&
      nombresProveedorCompatibles(contacto.nombre, recibo.proveedor);
  }

  private evidenciasConLimite(correo: CorreoAuto, recibo: ReciboAuto): Promise<EvidenciaAuto> {
    const pospuesto = this.motivoPospuesto();
    if (pospuesto) throw new Error(pospuesto);
    const restante = this.opciones.fechaLimite ? this.opciones.fechaLimite - Date.now() : 60_000;
    return conTiempoMaximo(() => this.puerto.evidencias(correo, recibo), Math.min(60_000, restante),
      "verificación automática en Holded");
  }

  private async estado(op: OperacionAuto, estado: OperacionAuto["estado"], detalle?: string): Promise<void> {
    op.estado = estado;
    op.detalle = detalle;
    if (estado !== "incierta") op.pasoIncierto = undefined;
    await this.store.guardar(op);
  }
  private exigirActivado(op: OperacionAuto): void {
    if (!this.puerto.permitidoAhora(op)) throw new Error("Automatización detenida; se conserva el progreso.");
  }

  /** No repite POST en vuelo ni errores de resultado desconocido. Las reservas sobreviven a reinicios. */
  async ejecutar(op: OperacionAuto, c: CorreoAuto, analisis: AnalisisAuto, config: ConfigAuto): Promise<boolean> {
    return this.puerto.ejecutarProtegido(op, async () => {
      if (op.estado === "completada" && op.plan.version === VERSION_POLITICA) return true;
      if (op.estado === "rechazada") return false;
      const reparacionLegada = op.plan.version !== VERSION_POLITICA &&
        (op.estado === "completada" || (op.estado === "incierta" && op.pasoIncierto === "completada"));
      if (reparacionLegada) {
        // Una operación de una política anterior puede haber quedado conciliada con la
        // cuenta o los tags del prototipo. Se relee y se corrige mediante el mismo flujo
        // aprendido de la revisión uno a uno, sin repetir la creación ni la conciliación.
        try {
          this.exigirActivado(op);
          op.compraId = await this.puerto.recuperarCreacion(op) ?? op.compraId;
          if (!op.compraId || !await this.puerto.verificarCreacion(op)) {
            throw new Error("No se pudo verificar la corrección del gasto anterior.");
          }
          const adjunto = await this.puerto.verificarAdjunto(op);
          const conciliada = adjunto && await this.puerto.verificarConciliacion(op);
          if (conciliada) {
            op.plan.version = VERSION_POLITICA;
            await this.estado(op, "completada");
            return true;
          }
          await this.estado(op, adjunto ? "adjuntada" : "creada");
        } catch (error) {
          console.error("[correo-auto] Reparación anterior no verificada:", {
            compraId: op.compraId,
            estado: op.estado,
            paso: op.pasoIncierto,
            error: mensajeError(error),
          });
          op.pasoIncierto = "completada";
          await this.estado(op, "incierta", mensajeError(error));
          return false;
        }
      }
      if (["creando", "adjuntando", "conciliando", "incierta"].includes(op.estado)) {
        // Recuperar un resultado conocido por lectura; nunca repetir el POST que quedó en vuelo.
        const paso = op.pasoIncierto ?? op.estado;
        try {
          if (paso === "creando") {
            const recuperada = await this.puerto.recuperarCreacion(op);
            op.compraId = recuperada ?? op.compraId;
            if (!op.compraId || !await this.puerto.verificarCreacion(op)) return false;
            await this.estado(op, "creada");
          } else if (paso === "adjuntando") {
            if (!op.compraId || !await this.puerto.verificarCreacion(op) || !await this.puerto.verificarAdjunto(op)) return false;
            await this.estado(op, "adjuntada");
          } else if (paso === "conciliando" || paso === "completada") {
            if (!op.compraId || !await this.puerto.verificarCreacion(op) ||
              !await this.puerto.verificarAdjunto(op) || !await this.puerto.verificarConciliacion(op)) return false;
            await this.estado(op, "completada");
            return true;
          } else if (paso === "creada") {
            if (!op.compraId || !await this.puerto.verificarCreacion(op)) return false;
            await this.estado(op, "creada");
          } else if (paso === "adjuntada") {
            if (!op.compraId || !await this.puerto.verificarCreacion(op) || !await this.puerto.verificarAdjunto(op)) return false;
            await this.estado(op, "adjuntada");
          } else return false;
        } catch (error) {
          await this.estado(op, "incierta", mensajeError(error));
          return false;
        }
      }
      try {
        if (op.estado === "reservada") {
          const evidencia = await this.evidenciasConLimite(c, op.plan.recibo);
          const decision = evaluarAuto(c, analisis, op.plan.recibo, evidencia, config);
          if (!decision.apto) throw new Error(`Revalidación: ${decision.motivos.join(", ")}`);
          this.mismoPlan(op.plan, decision.plan);
          this.exigirActivado(op);
          await this.estado(op, "creando");
          op.compraId = await this.puerto.crear(op);
          if (!op.compraId || !await this.puerto.verificarCreacion(op)) throw new Error("No se pudo verificar el gasto creado.");
          await this.estado(op, "creada");
        }
        if (op.estado === "creada") {
          this.exigirActivado(op);
          await this.puerto.prepararAdjunto(op, c);
          // El hash y el nombre del soporte deben sobrevivir a un reinicio
          // antes del POST. Así una recuperación verifica el archivo exacto.
          await this.store.guardar(op);
          await this.estado(op, "adjuntando");
          await this.puerto.adjuntar(op, c);
          if (!await this.puerto.verificarAdjunto(op)) throw new Error("Comprobante no verificado.");
          await this.estado(op, "adjuntada");
        }
        if (op.estado === "adjuntada") {
          // El puerto revalida también cuenta, saldo y movimiento justo antes del POST.
          this.exigirActivado(op);
          await this.estado(op, "conciliando");
          await this.puerto.conciliar(op);
          if (!await this.puerto.verificarConciliacion(op)) throw new Error("Conciliación o saldo final no verificados.");
          op.plan.version = VERSION_POLITICA;
          await this.estado(op, "completada");
        }
        return (op as OperacionAuto).estado === "completada";
      } catch (e) {
        // Si el guardado también falla, el último estado durable en vuelo sigue bloqueando repeticiones.
        op.pasoIncierto = op.estado;
        await this.estado(op, op.estado === "reservada" ? "rechazada" : "incierta", mensajeError(e));
        return false;
      }
    });
  }
  /**
   * `ejecutar` con una última salida: la verificación estricta compara campo por campo (cuenta, impuestos, tasa,
   * etiquetas) y deja «sin verificar» para siempre un gasto que alguien corrigió o cuyo cargo quedó con unos
   * céntimos de saldo (JetBlue y «Desayuno y Almuerzo», 2026-09-28). Si Holded demuestra que todo está hecho, se cierra.
   */
  private async ejecutarOCerrar(op: OperacionAuto, c: CorreoAuto, analisis: AnalisisAuto, config: ConfigAuto): Promise<boolean> {
    // Una reparación de política anterior pendiente NO se da por buena: cerrarla fijaría la versión vigente y la
    // cuenta o las etiquetas defectuosas que se estaba corrigiendo quedarían para siempre. Solo el operador presente
    // (resolverOperacionAnterior) puede cerrar esos casos.
    const eraReparacion = op.plan.version !== VERSION_POLITICA && (op.estado === "completada" || op.pasoIncierto === "completada");
    if (await this.ejecutar(op, c, analisis, config)) return true;
    if (!this.puerto.cerrarConEvidencia || !op.compraId || op.estado === "rechazada" || op.estado === "reservada" ||
      op.estado === "completada" || eraReparacion) return false;
    // Igual que ejecutar(): con la automatización apagada no se escribe nada, ni siquiera el estado de la operación.
    if (!this.puerto.permitidoAhora(op)) return false;
    try { return await this.puerto.cerrarConEvidencia(op); }
    catch (error) {
      console.warn("[correo-auto] No se pudo intentar el cierre con evidencia:", { operacion: op.id, error: mensajeError(error) });
      return false;
    }
  }
  private mismoPlan(a: PlanAuto, b: PlanAuto): void {
    if (a.empresa !== b.empresa || a.contactoId !== b.contactoId || a.cuentaId !== b.cuentaId ||
        a.totalCentimos !== b.totalCentimos || a.fuenteHash !== b.fuenteHash ||
        a.movimiento.id !== b.movimiento.id || a.movimiento.cuentaId !== b.movimiento.cuentaId ||
        a.movimiento.moneda !== b.movimiento.moneda) throw new Error("La evidencia cambió; requiere revisión.");
  }

  async revisar(config: ConfigAuto): Promise<ResultadoAuto> {
    const resultado: ResultadoAuto = { modo: config.modo, revisados: 0, completados: 0, simulados: 0,
      pendientes: [], gastos: [], reparados: [] };
    if (config.modo === "off") return resultado;
    if (!config.buzon) throw new Error("Buzón no configurado.");
    const correos = [...await this.puerto.listar()].sort((a, b) =>
      prioridadAnalisisAutomatico(b) - prioridadAnalisisAutomatico(a) ||
      a.recibidoEn - b.recibidoEn ||
      a.id.localeCompare(b.id)
    );
    resultado.encontrados = correos.length;
    const presupuestoAnalisis = {
      disponibles: Math.max(0, this.opciones.maxAnalisisNuevos ?? Number.POSITIVE_INFINITY),
    };
    let analizados = 0;
    await this.opciones.progreso?.({ fase: "analisis", completados: 0, total: correos.length });
    const preparados = await mapearConConcurrencia(correos, this.opciones.concurrenciaAnalisis ?? 2, async correo => {
      const preparado = await this.prepararCorreo(config, correo, presupuestoAnalisis);
      analizados++;
      await this.opciones.progreso?.({ fase: "analisis", completados: analizados, total: correos.length });
      return preparado;
    });
    resultado.aplazados = preparados.filter(preparado => preparado.motivos.some(motivo =>
      motivo === "revision_pospuesta_por_limite_de_coste" || motivo === "revision_pospuesta_por_limite_de_tiempo" ||
      motivo === "revision_pospuesta_por_limite_de_ia" || motivo === "revision_pospuesta_por_reinicio"
    )).length;
    resultado.bloqueadosPorPresupuestoIA = preparados.filter(preparado =>
      preparado.motivos.includes("revision_pospuesta_por_limite_de_ia")
    ).length;
    resultado.fallosAnalisis = preparados.filter(preparado => preparado.motivos.some(motivo =>
      motivo === "analisis_ia_no_disponible" || motivo === "fallo_temporal_analisis_ia" ||
      motivo === "fallo_tecnico_analisis_ia"
    )).length;
    resultado.reservados = preparados.filter(preparado =>
      preparado.motivos.includes("revision_manual_o_autorespuesta_activa")
    ).length;
    // Por operación: motivo principal + detalles que viajan con él (p. ej. «lectura:<parte no leída>»).
    const operacionesBloqueadas = new Map<string, string[]>();
    if (config.modo === "execute") {
      const recuperables = await this.store.recuperables(config.buzon, VERSION_POLITICA);
      let recuperados = 0;
      if (recuperables.length) {
        await this.opciones.progreso?.({ fase: "recuperacion", completados: 0, total: recuperables.length });
      }
      for (const op of recuperables) {
        // Con el cierre pedido no se abre ninguna reparación nueva: las operaciones siguen
        // recuperables tal cual para la pasada que retome la revisión.
        if (this.opciones.detener?.()) { this.interrumpida = true; break; }
        try {
          const correoNoLeido = correos.find(c => c.id === op.plan.correo.id);
          const reparacionLegada = op.plan.version !== VERSION_POLITICA &&
            (op.estado === "completada" || op.pasoIncierto === "completada");
          // Un correo reservado por la revisión manual no pasa por el bucle de abajo (se aparta sin analizarlo), y la
          // revisión manual a su vez rechaza un correo con una operación sin cerrar: sin esta lectura ninguno de los
          // dos podía terminarla (bloqueo mutuo, JetBlue 2026-09-28). Aquí solo se CONTINÚA la operación existente,
          // siempre por lectura y sin repetir POST; nunca se crea nada nuevo para ese correo.
          // Solo operaciones que YA crearon su compra: una `reservada` o sin compra registrada pasaría por `crear`, y
          // eso nunca debe ocurrir para un correo que tiene el operador abierto.
          const reservadoManual = Boolean(correoNoLeido) && op.estado !== "reservada" && Boolean(op.compraId) &&
            await this.puerto.reservadoManualmente(op.plan.correo.threadId);
          const debeRecuperarseAhora = reparacionLegada || op.estado === "completada" || !correoNoLeido || reservadoManual;
          if (!debeRecuperarseAhora) continue;
          const correo = correoNoLeido ?? await this.puerto.obtener(op.plan.correo.id, op.plan.correo.threadId);
          if (!correo) {
            resultado.pendientes.push({ mensajeId: op.plan.correo.id, asunto: op.plan.recibo.concepto,
              motivos: ["correo_original_no_disponible"], detalles: [this.detalleOperacion(op, "correo_original_no_disponible")] });
            continue;
          }
          const eraCompletadaAnterior = op.estado === "completada" || op.pasoIncierto === "completada";
          let analisisRecuperado: AnalisisAuto = { resumen: "Recuperación de operación durable existente", completo: true,
            recibos: [op.plan.recibo], otrasAcciones: false };
          if (op.plan.version !== VERSION_POLITICA) {
            try {
              analisisRecuperado = await this.analizarParaRecuperacion(config, correo);
              const recibosFuente = analisisRecuperado.recibos.filter(r => r.fuente === op.plan.recibo.fuente);
              if (!analisisRecuperado.completo || recibosFuente.length !== 1 ||
                !this.reciboCorrespondeALaMismaOperacion(op.plan.recibo, recibosFuente[0], op)) {
                // Caso real (Carlos, 07/08-10-2026): «5: el analizador no dio por completa la lectura» durante días. Tres
                // causas distintas salían con la misma etiqueta y ninguna decía qué pasaba: (a) lectura incompleta de verdad
                // (con su parte concreta), (b) la relectura no encuentra un único recibo en la misma parte que la operación
                // anterior, (c) el recibo releído no coincide (empresa, fecha o importe) con la operación anterior.
                const motivoRelectura = !analisisRecuperado.completo
                  ? "lectura_incompleta"
                  : recibosFuente.length !== 1 ? "relectura_sin_recibo_unico" : "relectura_no_coincide";
                const motivosRelectura = [motivoRelectura,
                  ...(!analisisRecuperado.completo && analisisRecuperado.detalleIncompleto
                    ? [`lectura:${analisisRecuperado.detalleIncompleto.slice(0, 200)}`] : []),
                  ...(motivoRelectura === "relectura_sin_recibo_unico" ? [`relectura:${recibosFuente.length} recibo(s) en la parte «${op.plan.recibo.fuente}»`] : []),
                  ...(motivoRelectura === "relectura_no_coincide"
                    ? [`relectura:antes ${op.plan.recibo.monto} ${op.plan.recibo.moneda} del ${op.plan.recibo.fecha}; ahora ${recibosFuente[0].monto} ${recibosFuente[0].moneda} del ${recibosFuente[0].fecha} (${recibosFuente[0].empresa}); difiere en: ${motivosDeNoCorrespondencia(op.plan.recibo, recibosFuente[0], op).join(", ")}`] : [])];
                operacionesBloqueadas.set(op.id, motivosRelectura);
                if (!correoNoLeido) resultado.pendientes.push({ mensajeId: correo.id, asunto: correo.asunto,
                  motivos: motivosRelectura, detalles: [this.detalleOperacion(op, motivosRelectura)] });
                continue;
              }
              const reciboActual = recibosFuente[0];
              const evidenciaActual = await this.evidenciasConLimite(correo, reciboActual);
              op.plan.recibo = reciboActual;
              if (!evidenciaActual.contacto?.id || !this.contactoSeguroParaReparar(reciboActual, evidenciaActual)) {
                const motivo = evidenciaActual.contacto?.id ? "proveedor_no_verificado" : "proveedor_no_encontrado";
                operacionesBloqueadas.set(op.id, [motivo]);
                if (!correoNoLeido) resultado.pendientes.push({ mensajeId: correo.id, asunto: correo.asunto,
                  motivos: [motivo], detalles: [this.detalleOperacion(op, motivo)] });
                continue;
              }
              op.plan.contactoId = evidenciaActual.contacto.id;
              op.plan.evidencia.contacto = evidenciaActual.contacto;
              op.plan.evidencia.motivoProveedor = evidenciaActual.motivoProveedor;
              op.plan.evidencia.candidatosProveedor = evidenciaActual.candidatosProveedor;
            } catch (error) {
              // Un fallo técnico al releer no es una lectura incompleta: se dice como lo que es y se reintenta en la siguiente pasada.
              const motivosFallo = ["relectura_fallida", `error:${mensajeError(error)}`];
              operacionesBloqueadas.set(op.id, motivosFallo);
              if (!correoNoLeido) resultado.pendientes.push({ mensajeId: correo.id, asunto: correo.asunto,
                motivos: motivosFallo, detalles: [this.detalleOperacion(op, motivosFallo)] });
              continue;
            }
          }
          if (await this.ejecutarOCerrar(op, correo, analisisRecuperado, config)) {
            const gasto = { empresa: op.plan.empresa, id: op.compraId!, centimos: op.plan.totalCentimos,
              moneda: op.plan.movimiento.moneda, proveedor: op.plan.recibo.proveedor };
            if (eraCompletadaAnterior) resultado.reparados!.push(gasto);
            else { resultado.completados++; resultado.gastos.push(gasto); }
            await this.puerto.registrarFinalizada(op);
            if (!correoNoLeido) await this.puerto.marcarResuelto(correo);
          } else {
            console.warn("[correo-auto] Operación durable aún no cerrada:", {
              compraId: op.compraId,
              estado: op.estado,
              paso: op.pasoIncierto,
              detalle: op.detalle,
            });
            if (!correoNoLeido) {
              const motivo = `operacion_${op.estado}:${op.id}`;
              resultado.pendientes.push({ mensajeId: correo.id, asunto: correo.asunto, motivos: [motivo],
                detalles: [this.detalleOperacion(op, motivo)] });
            }
          }
        } finally {
          recuperados++;
          await this.opciones.progreso?.({ fase: "recuperacion", completados: recuperados, total: recuperables.length });
        }
      }
    }
    let verificados = 0;
    await this.opciones.progreso?.({ fase: "verificacion", completados: 0, total: preparados.length });
    for (const preparado of preparados) {
      const { correo, analisis } = preparado;
      const motivos = [...preparado.motivos];
      const detalles: NonNullable<ResultadoAuto["pendientes"][number]["detalles"]> = [];
      try {
        if (analisis) {
          resultado.revisados++;
          if (!analisis.completo) {
            motivos.push("lectura_incompleta");
            // La parte CONCRETA que no se pudo leer (si el analizador la nombró) viaja con el motivo para decírsela al operador.
            if (analisis.detalleIncompleto) motivos.push(`lectura:${analisis.detalleIncompleto.slice(0, 200)}`);
          }
          if (analisis.otrasAcciones) motivos.push("otras_acciones_pendientes");
          if (analisis.motivoManual) motivos.push(analisis.motivoManual);
          if (!analisis.recibos.length) motivos.push("correo_sin_gastos_automatizables");
          for (const recibo of analisis.recibos) {
            if (!analisis.completo) break;
            const previa = await this.store.buscarFuente(config.buzon, correo.id, recibo.fuente);
            let op = previa;
            if (op && operacionesBloqueadas.has(op.id)) {
              const motivosBloqueo = operacionesBloqueadas.get(op.id)!;
              motivos.push(...motivosBloqueo);
              detalles.push(this.detalleOperacion(op, motivosBloqueo));
              continue;
            }
            if (op && op.estado === "reservada" && this.opciones.detener?.()) {
              // Una reserva todavía no escribió nada en Holded: con el cierre pedido se deja
              // reservada (la próxima pasada la ejecuta) antes que arrancar tres POST que el
              // SIGKILL podría cortar a medias.
              this.interrumpida = true;
              motivos.push("revision_pospuesta_por_reinicio");
              continue;
            }
            if (!op) {
              // Al agotar el presupuesto temporal (o con el cierre pedido) no se inicia una consulta
              // nueva de Holded ni una escritura. Las operaciones ya reservadas sí continúan para
              // llevarlas a un estado durable y verificable antes de responder.
              const pospuesto = this.motivoPospuesto();
              if (pospuesto) {
                motivos.push(pospuesto);
                continue;
              }
              const evidencia = await this.evidenciasConLimite(correo, recibo);
              const decision = evaluarAuto(correo, analisis, recibo, evidencia, config);
              await this.store.auditar({ buzon: config.buzon, mensajeId: correo.id, tipo: "decision", datos: {
                ...decision,
                diagnostico: {
                  proveedor: recibo.proveedor, fecha: recibo.fecha, moneda: recibo.moneda, monto: recibo.monto,
                  equivalente: recibo.equivalente ?? evidencia.equivalenteBancario,
                  consultasCompletas: evidencia.consultasCompletas,
                  movimientosConsultados: evidencia.movimientos.length,
                  candidatos: candidatosMovimientoAuto(recibo, evidencia).slice(0, 10).map(m => ({
                    cuentaId: m.cuentaId, id: m.id, fecha: m.fecha, moneda: m.moneda,
                    centimos: m.centimos, estado: m.estado, conciliadoCentimos: m.conciliadoCentimos,
                  })),
                  motivoProveedor: evidencia.motivoProveedor,
                },
              } });
              if (!decision.apto) {
                motivos.push(...decision.motivos);
                detalles.push({ proveedor: recibo.proveedor, empresa: recibo.empresa, monto: recibo.monto, moneda: recibo.moneda,
                  contacto: evidencia.contacto?.nombre, metodoContacto: evidencia.contacto?.metodo,
                  motivoProveedor: evidencia.motivoProveedor, motivos: decision.motivos });
                continue;
              }
              if (config.modo === "simulate") { resultado.simulados++; continue; }
              op = await this.store.reservar(decision.plan);
            }
            if (config.modo === "simulate") { motivos.push("operacion_pendiente_sin_escritura_en_simulacion"); continue; }
            const yaCompletada = op.estado === "completada";
            if (await this.ejecutarOCerrar(op, correo, analisis, config)) {
              if (!yaCompletada) {
                resultado.completados++;
                resultado.gastos.push({ empresa: op.plan.empresa, id: op.compraId!, centimos: op.plan.totalCentimos,
                  moneda: op.plan.movimiento.moneda, proveedor: op.plan.recibo.proveedor });
              }
              await this.puerto.registrarFinalizada(op);
            } else {
              const motivoOperacion = `operacion_${op.estado}:${op.id}`;
              motivos.push(motivoOperacion);
              detalles.push({ proveedor: recibo.proveedor, empresa: recibo.empresa, monto: recibo.monto, moneda: recibo.moneda,
                contacto: op.plan.evidencia.contacto?.nombre, metodoContacto: op.plan.evidencia.contacto?.metodo,
                motivoProveedor: op.plan.evidencia.motivoProveedor,
                motivos: [motivoOperacion, ...(op.detalle ? [`detalle:${op.detalle}`] : [])] });
            }
          }
          if (!motivos.length && config.modo === "execute") {
            await this.puerto.marcarResuelto(correo);
            await this.store.auditar({ buzon: config.buzon, mensajeId: correo.id, tipo: "correo_resuelto", datos: { huella: correo.huella } });
          }
          if (config.modo === "simulate") motivos.push("simulacion_sin_modificar_correo");
        }
      } catch (e) { motivos.push(`error:${mensajeError(e)}`); }
      if (motivos.length) resultado.pendientes.push({ mensajeId: correo.id, asunto: correo.asunto,
        motivos: [...new Set(motivos)], ...(detalles.length ? { detalles } : {}) });
      verificados++;
      await this.opciones.progreso?.({ fase: "verificacion", completados: verificados, total: preparados.length });
    }
    if (this.interrumpida) resultado.interrumpida = true;
    await this.store.auditar({ buzon: config.buzon, tipo: "revision_terminada", datos: resultado });
    return resultado;
  }

  /** El detalle por operación lleva TODOS los motivos (incluidas las partes «lectura:»/«relectura:»): la sección «Casos que el
   * operador debe revisar primero» se redacta desde aquí, y sin ellas volvía a salir el aviso genérico. */
  private detalleOperacion(op: OperacionAuto, motivo: string | string[]): NonNullable<ResultadoAuto["pendientes"][number]["detalles"]>[number] {
    const lista = Array.isArray(motivo) ? motivo : [motivo];
    return { proveedor: op.plan.recibo.proveedor, empresa: op.plan.empresa, monto: op.plan.recibo.monto,
      moneda: op.plan.recibo.moneda, contacto: op.plan.evidencia.contacto?.nombre,
      metodoContacto: op.plan.evidencia.contacto?.metodo, motivoProveedor: op.plan.evidencia.motivoProveedor,
      motivos: [...lista, ...(op.detalle ? [`detalle:${op.detalle}`] : [])] };
  }
}

type DetallePendiente = NonNullable<ResultadoAuto["pendientes"][number]["detalles"]>[number];

/** Frases que el informe NO puede usar: cada motivo dice su causa concreta (guardarraíl core/guardarrailes/motivosSinGenericos.test.ts). */
export const FRASES_GENERICAS_PROHIBIDAS = [
  "No se cumplieron todas las condiciones necesarias",
  "no dio por completa la lectura",
  "fallo temporal al leerla",
  "ya empezó, pero falta confirmar que quedó completa",
];

const PASOS_OPERACION: Record<string, string> = {
  reservada: "quedó reservada y aún no se creó en Holded",
  creando: "se estaba creando en Holded y no se confirmó",
  adjuntando: "se creó y quedó a medias al adjuntar el comprobante",
  conciliando: "se creó y quedó a medias al conciliar con el banco",
  incierta: "quedó en estado incierto (Holded no confirmó el último paso)",
  completada: "figura como completada pero falta la confirmación final",
};

export function explicarPendiente(motivos: string[], detalle?: DetallePendiente): string {
  const tiene = (valor: string) => motivos.some(motivo => motivo === valor || motivo.startsWith(`${valor}:`));
  const operacion = motivos.find(motivo => motivo.startsWith("operacion_"));
  if (operacion) {
    // Qué paso quedó a medias (nunca el id interno): «operacion_<estado>:<id>».
    const estado = operacion.slice("operacion_".length).split(":")[0];
    const paso = PASOS_OPERACION[estado] ?? `quedó en el paso «${estado.replace(/_/g, " ")}»`;
    return `La operación de una revisión anterior ${paso}; hay que comprobarla en Holded antes de continuarla.`;
  }
  if (tiene("posible_duplicado")) return "Puede estar registrado previamente; hay que comprobarlo antes de crear otro gasto.";
  if (tiene("no_es_ticket_o_recibo_pagado")) return "El documento no se identificó como recibo de pago; la búsqueda bancaria automática no se ejecutó.";
  if (tiene("verificacion_incompleta")) return "No se completaron las consultas de verificación; no se puede concluir que falte el cargo bancario.";
  if (tiene("proveedor_no_encontrado") || tiene("proveedor_no_verificado")) {
    if (detalle?.motivoProveedor === "coincidencia_ambigua") {
      return "Hay varios contactos posibles en Holded; el operador debe elegir el proveedor correcto.";
    }
    if (detalle?.contacto) {
      // Sin cargo en el banco tampoco hay con qué confirmar al proveedor: el motivo real es el cargo que falta.
      if (tiene("sin_movimiento_exacto")) {
        return `Todavía no hay en el banco un cargo que coincida; además falta confirmar que «${detalle.contacto}» sea el proveedor.`;
      }
      return `Se encontró «${detalle.contacto}», pero falta confirmar que sea el proveedor correcto.`;
    }
    return "No se encontró un contacto único y verificable para el proveedor en Holded.";
  }
  if (tiene("movimiento_no_libre")) return "El movimiento bancario compatible ya está usado o no está disponible para conciliar.";
  if (tiene("movimiento_ambiguo")) return "Hay más de un movimiento bancario posible y el sistema no puede elegir uno con seguridad.";
  if (tiene("coincidencia_aproximada_sin_proveedor_bancario")) {
    return "El importe y la fecha se aproximan, pero el banco no confirma al proveedor.";
  }
  if (tiene("sin_movimiento_exacto")) {
    return "No se encontró un movimiento compatible con las reglas de importe, moneda y fecha, mediante el equivalente contable de Holded " +
      "ni mediante una conversión respaldada por el proveedor y la fecha; requiere revisión manual.";
  }
  if (tiene("cuenta_contable_no_verificada")) {
    return "Los aprendizajes actuales no permiten elegir una cuenta contable con seguridad.";
  }
  if (tiene("confianza_insuficiente")) return "La lectura del comprobante no alcanzó la confianza necesaria para automatizar.";
  // Los aplazamientos también pueden llegar como `error:<motivo>` (lanzados desde la consulta de
  // evidencias); van antes del comodín `error:` para no disfrazarlos de «no se pudo leer».
  if (tiene("revision_pospuesta_por_reinicio") || tiene("error:revision_pospuesta_por_reinicio")) {
    return "La revisión se interrumpió por un reinicio del servicio; se retoma en la siguiente pasada.";
  }
  if (tiene("revision_pospuesta_por_limite_de_tiempo") || tiene("error:revision_pospuesta_por_limite_de_tiempo")) {
    return "La revisión se aplazó para no superar el tiempo máximo de ejecución.";
  }
  // Caso real (Carlos, 2026-09-30): «9: No se pudo leer o verificar todo el contenido del correo» agrupaba hilos largos
  // con la gestoría, operaciones de días anteriores sin cerrar y fallos técnicos de una consulta. Ninguno era un
  // comprobante ilegible. Cada causa dice ahora lo que es.
  // Sin identificadores internos: el informe es para el operador, no un registro técnico.
  const acotar = (texto: string) => {
    const limpio = texto.replace(/[0-9a-f]{8}-[0-9a-f-]{20,}|[0-9a-f]{16,}/gi, "…").replace(/\s+/g, " ").trim();
    return limpio.length > 140 ? `${limpio.slice(0, 137)}…` : limpio;
  };
  const errorTecnico = motivos.find(motivo => motivo.startsWith("error:"))?.slice("error:".length).trim();
  const detalleOperacion = motivos.find(motivo => motivo.startsWith("detalle:"))?.slice("detalle:".length).trim();
  if (tiene("relectura_sin_recibo_unico") || tiene("relectura_no_coincide")) {
    const que = motivos.find(motivo => motivo.startsWith("relectura:"))?.slice("relectura:".length).trim();
    const base = tiene("relectura_sin_recibo_unico")
      ? "Al releer el correo con el analizador actual no aparece un único recibo en la misma parte que usó la operación anterior"
      : "Al releer el correo, el recibo no coincide con el de la operación anterior";
    return `${base}${que ? ` (${acotar(que)})` : ""}; revisa esa operación a mano antes de continuarla (no es un comprobante ilegible).`;
  }
  if (tiene("lectura_excede_limite")) {
    return "El hilo es demasiado largo para leerlo entero de forma automática; revísalo a mano (no es un comprobante ilegible).";
  }
  if ((tiene("lectura_incompleta") || errorTecnico) && detalleOperacion) {
    return `Operación de una revisión anterior que sigue sin cerrar: ${acotar(detalleOperacion)}`;
  }
  if (errorTecnico) return `Una comprobación técnica falló y se reintentará en la siguiente pasada: ${acotar(errorTecnico)}`;
  if (tiene("lectura_incompleta")) {
    const parte = motivos.find(motivo => motivo.startsWith("lectura:"))?.slice("lectura:".length).trim();
    return parte
      ? `El analizador no pudo leer una parte de este correo: ${acotar(parte)}`
      : "El analizador marcó la lectura como incompleta sin nombrar la parte que no pudo leer; se trata como fallo del analizador y hay que revisar el correo a mano.";
  }
  if (tiene("otras_acciones_pendientes")) return "El correo contiene además otra solicitud que debe revisar el operador.";
  if (tiene("correo_sin_gastos_automatizables")) return "El correo no contiene un ticket o recibo que se pueda registrar automáticamente.";
  if (tiene("revision_manual_o_autorespuesta_activa")) return "Este correo ya está reservado para otro flujo de revisión.";
  if (tiene("revision_pospuesta_por_limite_de_coste")) return "La revisión se aplazó al alcanzar el máximo seguro de análisis nuevos de esta pasada.";
  if (tiene("revision_pospuesta_por_limite_de_ia")) return "El análisis no se ejecutó porque se alcanzó el presupuesto diario de IA configurado.";
  if (tiene("analisis_ia_no_disponible")) return "La política de IA no autorizó este análisis.";
  if (tiene("fallo_temporal_analisis_ia")) return "El servicio de análisis tuvo un fallo temporal; el correo se conserva para reintento.";
  if (tiene("fallo_tecnico_analisis_ia")) return "El analizador no pudo completar este correo; el motivo técnico quedó registrado.";
  if (tiene("correo_original_no_disponible")) return "La operación existe, pero Gmail ya no permite recuperar el comprobante original.";
  if (motivos.some(motivo => motivo.startsWith("error_automatico:"))) {
    const que = motivos.find(motivo => motivo.startsWith("error_automatico:"))?.slice("error_automatico:".length).trim();
    return `La fase automática se interrumpió${que ? ` (${acotar(que)})` : ""}; el correo se conserva para revisión manual.`;
  }
  const quien = detalle?.proveedor ? `«${detalle.proveedor}»` : "el comprobante";
  const importe = detalle?.monto !== undefined && detalle?.moneda ? ` (${detalle.monto} ${detalle.moneda})` : "";
  if (tiene("empresa_en_conflicto_con_el_comprador")) return `La factura va a nombre de una sociedad distinta de la que sugiere el contexto; hay que decidir a qué empresa pertenece ${quien}${importe}.`;
  if (tiene("empresa_no_habilitada_o_ambigua")) return `No se pudo determinar con seguridad a qué empresa pertenece ${quien}${importe}${detalle?.empresa ? ` (el analizador propuso ${detalle.empresa})` : ""}.`;
  if (tiene("falta_evidencia")) return `El analizador no citó la evidencia del documento (proveedor, importe y fecha, o la empresa) para ${quien}${importe}.`;
  if (tiene("fecha_invalida")) return `La fecha del comprobante de ${quien}${importe} no es válida o no está; hay que confirmarla a mano.`;
  if (tiene("moneda_invalida")) return `La moneda leída para ${quien} no es un código válido (${detalle?.moneda || "vacía"}); hay que corregirla a mano.`;
  if (tiene("datos_incompletos")) return `Falta el proveedor o el concepto del gasto${importe}; hay que completarlos a mano.`;
  if (tiene("importe_o_equivalente_invalido")) return `El importe o su equivalente bancario de ${quien} no son coherentes; hay que revisarlos a mano.`;
  if (tiene("fuente_inexistente")) return `El recibo de ${quien} se atribuyó a un adjunto que no existe en el correo; hay que revisarlo a mano.`;
  if (tiene("varios_gastos_en_misma_fuente")) return `El mismo adjunto o cuerpo contiene varios recibos (${quien}${importe}); se registran a mano uno a uno.`;
  if (tiene("tipo_ticket_no_soportado") || motivos.some(motivo => motivo.startsWith("tipo_"))) {
    const tipo = motivos.find(motivo => motivo.startsWith("tipo_"))?.replace(/^tipo_/, "").replace(/_/g, " ");
    return `El tipo de documento de ${quien} no se registra automáticamente como ticket (${tipo || "tipo no soportado"}); se crea a mano.`;
  }
  if (tiene("operacion_pendiente_sin_escritura_en_simulacion")) return "Modo simulación: la operación se habría ejecutado, pero no se escribió nada.";
  if (tiene("simulacion_sin_modificar_correo")) return "Modo simulación: el correo no se marcó como leído.";
  if (tiene("relectura_fallida")) return "La relectura del correo falló por un error técnico; se reintenta en la siguiente pasada.";
  // Ningún motivo conocido llega aquí (guardarraíl). Si uno nuevo lo hace, se nombra en claro en vez de esconderlo.
  const legible = motivos.map(motivo => motivo.split(":")[0].replace(/_/g, " ")).filter(Boolean).join(", ");
  return `Motivo sin explicación catalogada (${legible || "sin motivo"}); revisar a mano y avisar al equipo.`;
}

/** Máximo de compras que el informe detalla una a una; el resto se resume en «y N más». */
export const MAX_GASTOS_DETALLADOS_EN_INFORME = 10;

/**
 * Una línea por compra, con el proveedor cuando se conoce (solo el id de compra no le dice nada a quien lee el informe).
 * El detalle está acotado: antes crecía sin límite con el volumen y un informe de 49 correos superó los 4096 caracteres de
 * Telegram, con lo que el envío falló aunque el trabajo ya estuviera hecho (2026-09-28).
 */
function lineasGastosAcotadas(gastos: ResultadoAuto["gastos"]): string[] {
  const lineas = gastos.slice(0, MAX_GASTOS_DETALLADOS_EN_INFORME).map(g => {
    const proveedor = g.proveedor?.trim() ? ` · ${g.proveedor.trim().slice(0, 32)}` : "";
    return `• ${g.empresa}${proveedor} · ${(g.centimos / 100).toFixed(2)} ${g.moneda} · compra ${g.id}.`;
  });
  if (gastos.length > MAX_GASTOS_DETALLADOS_EN_INFORME) {
    lineas.push(`• … y ${gastos.length - MAX_GASTOS_DETALLADOS_EN_INFORME} más, en Holded.`);
  }
  return lineas;
}

export function resumenAutomatico(r: ResultadoAuto, opciones: { revisionesConsolidadas?: number } = {}): string {
  if (r.modo === "off") return "";
  const consolidado = opciones.revisionesConsolidadas;
  const lineas = [r.modo === "simulate" ? "🔎 Simulación de revisión automática terminada." :
    consolidado ? "📬 Informe consolidado de revisión automática." : "📬 Revisión automática terminada.",
    ...(consolidado ? [`Revisiones incluidas desde el informe anterior: ${consolidado}.`] : []),
    ...(r.encontrados !== undefined ? [`Correos encontrados para el pase automático: ${r.encontrados}.`] : []),
    `${consolidado ? "Correos analizados en la revisión más reciente" : "Correos analizados automáticamente"}: ${r.revisados}.`,
    ...(r.reservados ? [`Ya estaban bajo revisión manual o autorrespuesta: ${r.reservados}.`] : []),
    ...(r.interrumpida ? ["⏸️ Pasada interrumpida por un reinicio del servicio: resultado parcial."] : []),
    ...(r.aplazados ? [`Correos aplazados sin analizar en esta pasada: ${r.aplazados}.`] : []),
    ...(r.bloqueadosPorPresupuestoIA ?
      [`Análisis detenidos por el presupuesto diario de IA: ${r.bloqueadosPorPresupuestoIA}. No se clasificaron como correos ilegibles.`] : []),
    ...(r.fallosAnalisis ? [`Fallos técnicos del analizador: ${r.fallosAnalisis}. Los correos permanecen sin leer para reintento.`] : []),
    `Gastos creados, soportados y conciliados: ${r.completados}.`,
    ...(r.modo === "simulate" ? [`${r.simulados} gasto(s) cumplirían los requisitos. No se modificó Holded ni Gmail.`] : []),
    `Mensajes con asuntos pendientes (incluye operaciones anteriores; no equivale a hilos sin leer): ${new Set(r.pendientes.map(p => p.mensajeId)).size}.`];
  if (r.gastos.length) {
    const porEmpresa = new Map<string, number>();
    for (const g of r.gastos) porEmpresa.set(g.empresa, (porEmpresa.get(g.empresa) ?? 0) + 1);
    lineas.push("", "✅ Automatizados por empresa");
    for (const [empresa, cantidad] of porEmpresa) lineas.push(`• ${empresa}: ${cantidad}.`);
    lineas.push("Compras verificadas para convertir manualmente a ticket:", ...lineasGastosAcotadas(r.gastos));
  }
  if (r.reparados?.length) {
    lineas.push("", `🛠️ Borradores anteriores corregidos y verificados: ${r.reparados.length}.`, ...lineasGastosAcotadas(r.reparados));
  }
  // Un correo sin ningún comprobante (consultas, propuestas, avisos, hilos con la gestoría) no es un gasto que la
  // automatización haya dejado de hacer: va aparte y no engorda la lista de «por qué no se automatizó».
  const esNoGasto = (p: ResultadoAuto["pendientes"][number]) => !p.detalles?.length &&
    (p.motivos.includes("correo_sin_gastos_automatizables") || p.motivos.includes("lectura_excede_limite")) &&
    !p.motivos.some(m => m.startsWith("error:") || m.startsWith("operacion_"));
  const noGastos = r.pendientes.filter(esNoGasto);
  const pendientesDeGasto = r.pendientes.filter(p => !esNoGasto(p));
  if (noGastos.length) {
    const largos = noGastos.filter(p => p.motivos.includes("lectura_excede_limite")).length;
    lineas.push("", `📨 Correos que no son gastos y esperan tu revisión: ${noGastos.length}` +
      (largos ? ` (${largos} ${largos === 1 ? "es un hilo demasiado largo" : "son hilos demasiado largos"} para leerlo entero).` : "."));
  }
  if (pendientesDeGasto.length) {
    const motivosPrincipales = new Map<string, number>();
    for (const pendiente of pendientesDeGasto) {
      const detalle = pendiente.detalles?.[0];
      const explicacion = explicarPendiente([...pendiente.motivos, ...(detalle?.motivos ?? [])], detalle);
      motivosPrincipales.set(explicacion, (motivosPrincipales.get(explicacion) ?? 0) + 1);
    }
    lineas.push("", "🟡 Por qué quedaron gastos para revisión manual");
    for (const [motivo, cantidad] of [...motivosPrincipales]) lineas.push(`• ${cantidad}: ${motivo}`);

    const detalles = pendientesDeGasto.flatMap(p => (p.detalles ?? []).map(d => ({ ...d })));
    if (detalles.length) {
      lineas.push("", "Casos que el operador debe revisar primero:");
      for (const detalle of detalles.slice(0, 6)) {
        lineas.push(`• ${detalle.empresa} · ${detalle.proveedor} · ${detalle.monto} ${detalle.moneda}`);
        lineas.push(`  ${explicarPendiente(detalle.motivos, detalle)}`);
      }
      if (detalles.length > 6) {
        lineas.push(`Los ${detalles.length - 6} casos restantes se mostrarán uno a uno en la revisión manual.`);
      }
    }
  }
  return lineas.join("\n");
}

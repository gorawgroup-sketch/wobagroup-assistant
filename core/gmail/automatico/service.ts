import { evaluarAuto, type AnalisisAuto, type ConfigAuto, type CorreoAuto, type EvidenciaAuto,
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
  adjuntar(op: OperacionAuto, correo: CorreoAuto): Promise<void>;
  verificarAdjunto(op: OperacionAuto): Promise<boolean>;
  conciliar(op: OperacionAuto): Promise<void>;
  verificarConciliacion(op: OperacionAuto): Promise<boolean>;
  /** Marca leído y etiqueta solo el mensaje cuya creación, soporte y conciliación ya fueron verificados. */
  marcarResuelto(correo: CorreoAuto): Promise<void>;
  permitidoAhora(op: OperacionAuto): boolean;
  ejecutarProtegido<T>(op: OperacionAuto, tarea: () => Promise<T>): Promise<T>;
}
const mensajeError = (e: unknown) => e instanceof Error ? e.message : "Error de verificación";
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
      progreso?: (p: ProgresoRevision) => void | Promise<void> } = {}) {}

  private async prepararCorreo(
    config: ConfigAuto,
    correo: CorreoAuto,
    presupuesto: { disponibles: number }
  ): Promise<CorreoPreparado> {
    try {
      if (await this.puerto.reservadoManualmente(correo.threadId)) {
        return { correo, motivos: ["revision_manual_o_autorespuesta_activa"] };
      }
      let analisis = await this.store.buscarAnalisis(config.buzon, correo.id, correo.huella, VERSION_ANALISIS);
      if (!analisis) {
        if (this.opciones.fechaLimite && Date.now() >= this.opciones.fechaLimite) {
          return { correo, motivos: ["revision_pospuesta_por_limite_de_tiempo"] };
        }
        if (presupuesto.disponibles <= 0) {
          return { correo, motivos: ["revision_pospuesta_por_limite_de_coste"] };
        }
        presupuesto.disponibles--;
        analisis = await this.puerto.analizar(correo);
        await this.store.guardarAnalisis(config.buzon, correo.id, correo.huella, VERSION_ANALISIS, analisis);
        await this.store.auditar({ buzon: config.buzon, mensajeId: correo.id, tipo: "analisis",
          datos: { huella: correo.huella, resumen: analisis.resumen, recibos: analisis.recibos, completo: analisis.completo,
            otrasAcciones: analisis.otrasAcciones, origen: "observacion_automatica_no_confirmada" } });
      }
      return { correo, analisis, motivos: [] };
    } catch (error) {
      const motivo = motivoFalloAnalisis(error);
      console.warn("[correo-auto] No se completó el análisis del mensaje:", {
        mensajeId: correo.id,
        motivo,
        error: error instanceof Error ? error.name : "Error",
      });
      await this.store.auditar({ buzon: config.buzon, mensajeId: correo.id, tipo: "analisis_no_completado",
        datos: { motivo, error: error instanceof Error ? error.name : "Error" } }).catch(auditError =>
        console.warn("[correo-auto] No se pudo auditar el fallo del analizador:",
          auditError instanceof Error ? auditError.name : "Error")
      );
      return { correo, motivos: [motivo] };
    }
  }

  private async analizarParaRecuperacion(config: ConfigAuto, correo: CorreoAuto): Promise<AnalisisAuto> {
    let analisis = await this.store.buscarAnalisis(config.buzon, correo.id, correo.huella, VERSION_ANALISIS);
    if (!analisis) {
      analisis = await this.puerto.analizar(correo);
      await this.store.guardarAnalisis(config.buzon, correo.id, correo.huella, VERSION_ANALISIS, analisis);
      await this.store.auditar({ buzon: config.buzon, mensajeId: correo.id, tipo: "reanalisis_reparacion",
        datos: { huella: correo.huella, resumen: analisis.resumen, recibos: analisis.recibos,
          completo: analisis.completo, origen: "relectura_de_operacion_anterior" } });
    }
    return analisis;
  }

  private reciboCorrespondeALaMismaOperacion(anterior: ReciboAuto, actual: ReciboAuto, op: OperacionAuto): boolean {
    const centimos = (monto: number) => Math.round(monto * 100);
    const anteriorContable = anterior.equivalente ?? { monto: anterior.monto, moneda: anterior.moneda };
    const actualContable = actual.equivalente ?? { monto: actual.monto, moneda: actual.moneda };
    const tolerancia = Math.max(0, op.plan.toleranciaCentimos);
    return actual.fuente === anterior.fuente && actual.empresa === op.plan.empresa &&
      actual.fecha === anterior.fecha && actualContable.moneda === anteriorContable.moneda &&
      Math.abs(centimos(actualContable.monto) - centimos(anteriorContable.monto)) <= tolerancia &&
      Math.abs(centimos(actualContable.monto) - op.plan.totalCentimos) <= tolerancia;
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
    const restante = this.opciones.fechaLimite ? this.opciones.fechaLimite - Date.now() : 60_000;
    if (restante <= 0) throw new Error("revision_pospuesta_por_limite_de_tiempo");
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
      motivo === "revision_pospuesta_por_limite_de_ia"
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
    const operacionesBloqueadas = new Map<string, string>();
    if (config.modo === "execute") {
      const recuperables = await this.store.recuperables(config.buzon, VERSION_POLITICA);
      let recuperados = 0;
      if (recuperables.length) {
        await this.opciones.progreso?.({ fase: "recuperacion", completados: 0, total: recuperables.length });
      }
      for (const op of recuperables) {
        try {
          const correoNoLeido = correos.find(c => c.id === op.plan.correo.id);
          const reparacionLegada = op.plan.version !== VERSION_POLITICA &&
            (op.estado === "completada" || op.pasoIncierto === "completada");
          const debeRecuperarseAhora = reparacionLegada || op.estado === "completada" || !correoNoLeido;
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
                operacionesBloqueadas.set(op.id, "lectura_incompleta");
                if (!correoNoLeido) resultado.pendientes.push({ mensajeId: correo.id, asunto: correo.asunto,
                  motivos: ["lectura_incompleta"], detalles: [this.detalleOperacion(op, "lectura_incompleta")] });
                continue;
              }
              const reciboActual = recibosFuente[0];
              const evidenciaActual = await this.evidenciasConLimite(correo, reciboActual);
              op.plan.recibo = reciboActual;
              if (!evidenciaActual.contacto?.id || !this.contactoSeguroParaReparar(reciboActual, evidenciaActual)) {
                const motivo = evidenciaActual.contacto?.id ? "proveedor_no_verificado" : "proveedor_no_encontrado";
                operacionesBloqueadas.set(op.id, motivo);
                if (!correoNoLeido) resultado.pendientes.push({ mensajeId: correo.id, asunto: correo.asunto,
                  motivos: [motivo], detalles: [this.detalleOperacion(op, motivo)] });
                continue;
              }
              op.plan.contactoId = evidenciaActual.contacto.id;
              op.plan.evidencia.contacto = evidenciaActual.contacto;
              op.plan.evidencia.motivoProveedor = evidenciaActual.motivoProveedor;
              op.plan.evidencia.candidatosProveedor = evidenciaActual.candidatosProveedor;
            } catch (error) {
              operacionesBloqueadas.set(op.id, "lectura_incompleta");
              if (!correoNoLeido) resultado.pendientes.push({ mensajeId: correo.id, asunto: correo.asunto,
                motivos: ["lectura_incompleta"], detalles: [this.detalleOperacion(op, `error:${mensajeError(error)}`)] });
              continue;
            }
          }
          if (await this.ejecutar(op, correo, analisisRecuperado, config)) {
            const gasto = { empresa: op.plan.empresa, id: op.compraId!, centimos: op.plan.totalCentimos,
              moneda: op.plan.movimiento.moneda };
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
          if (!analisis.completo) motivos.push("lectura_incompleta");
          if (analisis.otrasAcciones) motivos.push("otras_acciones_pendientes");
          if (analisis.motivoManual) motivos.push(analisis.motivoManual);
          if (!analisis.recibos.length) motivos.push("correo_sin_gastos_automatizables");
          for (const recibo of analisis.recibos) {
            if (!analisis.completo) break;
            const previa = await this.store.buscarFuente(config.buzon, correo.id, recibo.fuente);
            let op = previa;
            if (op && operacionesBloqueadas.has(op.id)) {
              const motivo = operacionesBloqueadas.get(op.id)!;
              motivos.push(motivo);
              detalles.push(this.detalleOperacion(op, motivo));
              continue;
            }
            if (!op) {
              // Al agotar el presupuesto temporal no se inicia una consulta nueva de Holded ni una
              // escritura. Las operaciones ya reservadas sí continúan para llevarlas a un estado
              // durable y verificable antes de responder.
              if (this.opciones.fechaLimite && Date.now() >= this.opciones.fechaLimite) {
                motivos.push("revision_pospuesta_por_limite_de_tiempo");
                continue;
              }
              const evidencia = await this.evidenciasConLimite(correo, recibo);
              const decision = evaluarAuto(correo, analisis, recibo, evidencia, config);
              await this.store.auditar({ buzon: config.buzon, mensajeId: correo.id, tipo: "decision", datos: decision });
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
            if (await this.ejecutar(op, correo, analisis, config)) {
              if (!yaCompletada) {
                resultado.completados++;
                resultado.gastos.push({ empresa: op.plan.empresa, id: op.compraId!, centimos: op.plan.totalCentimos, moneda: op.plan.movimiento.moneda });
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
    await this.store.auditar({ buzon: config.buzon, tipo: "revision_terminada", datos: resultado });
    return resultado;
  }

  private detalleOperacion(op: OperacionAuto, motivo: string): NonNullable<ResultadoAuto["pendientes"][number]["detalles"]>[number] {
    return { proveedor: op.plan.recibo.proveedor, empresa: op.plan.empresa, monto: op.plan.recibo.monto,
      moneda: op.plan.recibo.moneda, contacto: op.plan.evidencia.contacto?.nombre,
      metodoContacto: op.plan.evidencia.contacto?.metodo, motivoProveedor: op.plan.evidencia.motivoProveedor,
      motivos: [motivo, ...(op.detalle ? [`detalle:${op.detalle}`] : [])] };
  }
}

type DetallePendiente = NonNullable<ResultadoAuto["pendientes"][number]["detalles"]>[number];

function explicarPendiente(motivos: string[], detalle?: DetallePendiente): string {
  const tiene = (valor: string) => motivos.some(motivo => motivo === valor || motivo.startsWith(`${valor}:`));
  if (motivos.some(motivo => motivo.startsWith("operacion_"))) {
    return "La operación ya empezó, pero falta confirmar que quedó completa en Holded.";
  }
  if (tiene("posible_duplicado")) return "Puede estar registrado previamente; hay que comprobarlo antes de crear otro gasto.";
  if (tiene("movimiento_no_libre")) return "El movimiento bancario compatible ya está usado o no está disponible para conciliar.";
  if (tiene("movimiento_ambiguo")) return "Hay más de un movimiento bancario posible y el sistema no puede elegir uno con seguridad.";
  if (tiene("coincidencia_aproximada_sin_proveedor_bancario")) {
    return "El importe y la fecha se aproximan, pero el banco no confirma al proveedor.";
  }
  if (tiene("sin_movimiento_exacto")) return "No se encontró un movimiento bancario pendiente compatible con el importe y la fecha.";
  if (tiene("proveedor_no_encontrado") || tiene("proveedor_no_verificado")) {
    if (detalle?.motivoProveedor === "coincidencia_ambigua") {
      return "Hay varios contactos posibles en Holded; el operador debe elegir el proveedor correcto.";
    }
    if (detalle?.contacto) {
      return `Se encontró «${detalle.contacto}», pero falta confirmar que sea el proveedor correcto.`;
    }
    return "No se encontró un contacto único y verificable para el proveedor en Holded.";
  }
  if (tiene("cuenta_contable_no_verificada")) {
    return "Los aprendizajes actuales no permiten elegir una cuenta contable con seguridad.";
  }
  if (tiene("confianza_insuficiente")) return "La lectura del comprobante no alcanzó la confianza necesaria para automatizar.";
  if (tiene("lectura_incompleta") || motivos.some(motivo => motivo.startsWith("error:"))) {
    return "No se pudo leer o verificar todo el contenido del correo.";
  }
  if (tiene("otras_acciones_pendientes")) return "El correo contiene además otra solicitud que debe revisar el operador.";
  if (tiene("correo_sin_gastos_automatizables")) return "El correo no contiene un ticket o recibo que se pueda registrar automáticamente.";
  if (tiene("revision_manual_o_autorespuesta_activa")) return "Este correo ya está reservado para otro flujo de revisión.";
  if (tiene("revision_pospuesta_por_limite_de_tiempo")) return "La revisión se aplazó para no superar el tiempo máximo de ejecución.";
  if (tiene("revision_pospuesta_por_limite_de_coste")) return "La revisión se aplazó al alcanzar el máximo seguro de análisis nuevos de esta pasada.";
  if (tiene("revision_pospuesta_por_limite_de_ia")) return "El análisis no se ejecutó porque se alcanzó el presupuesto diario de IA configurado.";
  if (tiene("analisis_ia_no_disponible")) return "La política de IA no autorizó este análisis.";
  if (tiene("fallo_temporal_analisis_ia")) return "El servicio de análisis tuvo un fallo temporal; el correo se conserva para reintento.";
  if (tiene("fallo_tecnico_analisis_ia")) return "El analizador no pudo completar este correo; el motivo técnico quedó registrado.";
  if (tiene("correo_original_no_disponible")) return "La operación existe, pero Gmail ya no permite recuperar el comprobante original.";
  if (motivos.some(motivo => motivo.startsWith("error_automatico:"))) return "La fase automática no terminó y el correo se conserva para revisión manual.";
  return "No se cumplieron todas las condiciones necesarias para automatizarlo con seguridad.";
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
    ...(r.aplazados ? [`Correos aplazados sin analizar en esta pasada: ${r.aplazados}.`] : []),
    ...(r.bloqueadosPorPresupuestoIA ?
      [`Análisis detenidos por el presupuesto diario de IA: ${r.bloqueadosPorPresupuestoIA}. No se clasificaron como correos ilegibles.`] : []),
    ...(r.fallosAnalisis ? [`Fallos técnicos del analizador: ${r.fallosAnalisis}. Los correos permanecen sin leer para reintento.`] : []),
    `Gastos creados, soportados y conciliados: ${r.completados}.`,
    ...(r.modo === "simulate" ? [`${r.simulados} gasto(s) cumplirían los requisitos. No se modificó Holded ni Gmail.`] : []),
    `Correos que requieren revisión manual: ${r.pendientes.length}.`];
  if (r.gastos.length) {
    const porEmpresa = new Map<string, number>();
    for (const g of r.gastos) porEmpresa.set(g.empresa, (porEmpresa.get(g.empresa) ?? 0) + 1);
    lineas.push("", "✅ Automatizados por empresa");
    for (const [empresa, cantidad] of porEmpresa) lineas.push(`• ${empresa}: ${cantidad}.`);
    lineas.push("Compras verificadas para convertir manualmente a ticket:");
    for (const g of r.gastos) lineas.push(`• ${g.empresa} · ${(g.centimos / 100).toFixed(2)} ${g.moneda} · compra ${g.id}.`);
  }
  if (r.reparados?.length) {
    lineas.push("", `🛠️ Borradores anteriores corregidos y verificados: ${r.reparados.length}.`);
    for (const g of r.reparados) lineas.push(`• ${g.empresa} · ${(g.centimos / 100).toFixed(2)} ${g.moneda} · compra ${g.id}.`);
  }
  if (r.pendientes.length) {
    const motivosPrincipales = new Map<string, number>();
    for (const pendiente of r.pendientes) {
      const detalle = pendiente.detalles?.[0];
      const explicacion = explicarPendiente([...pendiente.motivos, ...(detalle?.motivos ?? [])], detalle);
      motivosPrincipales.set(explicacion, (motivosPrincipales.get(explicacion) ?? 0) + 1);
    }
    lineas.push("", "🟡 Por qué quedaron correos para revisión manual");
    for (const [motivo, cantidad] of [...motivosPrincipales].slice(0, 5)) lineas.push(`• ${cantidad}: ${motivo}`);

    const detalles = r.pendientes.flatMap(p => (p.detalles ?? []).map(d => ({ ...d })));
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

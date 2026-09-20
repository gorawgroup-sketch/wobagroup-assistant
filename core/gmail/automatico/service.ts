import { evaluarAuto, type AnalisisAuto, type ConfigAuto, type CorreoAuto, type EvidenciaAuto,
  type OperacionAuto, type PlanAuto, type ReciboAuto, type ResultadoAuto, type StoreAuto, VERSION_POLITICA } from "./model";
import { mapearConConcurrencia } from "../../utils/mapearConConcurrencia";

export interface PuertoAutomatico {
  listar(): Promise<CorreoAuto[]>;
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
  /** Solo elimina UNREAD de los mensajes concretos procesados, nunca de un hilo completo. */
  marcarResuelto(correo: CorreoAuto): Promise<void>;
  permitidoAhora(op: OperacionAuto): boolean;
  ejecutarProtegido<T>(op: OperacionAuto, tarea: () => Promise<T>): Promise<T>;
}
const mensajeError = (e: unknown) => e instanceof Error ? e.message : "Error de verificación";
type ProgresoRevision = { fase: "analisis" | "verificacion"; completados: number; total: number };
type CorreoPreparado = { correo: CorreoAuto; analisis?: AnalisisAuto; motivos: string[] };

export class ServicioCorreoAutomatico {
  constructor(private readonly store: StoreAuto, private readonly puerto: PuertoAutomatico,
    private readonly opciones: { concurrenciaAnalisis?: number; fechaLimite?: number;
      progreso?: (p: ProgresoRevision) => void | Promise<void> } = {}) {}

  private async prepararCorreo(config: ConfigAuto, correo: CorreoAuto): Promise<CorreoPreparado> {
    try {
      if (await this.puerto.reservadoManualmente(correo.threadId)) {
        return { correo, motivos: ["revision_manual_o_autorespuesta_activa"] };
      }
      let analisis = await this.store.buscarAnalisis(config.buzon, correo.id, correo.huella, VERSION_POLITICA);
      if (!analisis) {
        if (this.opciones.fechaLimite && Date.now() >= this.opciones.fechaLimite) {
          return { correo, motivos: ["revision_pospuesta_por_limite_de_tiempo"] };
        }
        analisis = await this.puerto.analizar(correo);
        await this.store.guardarAnalisis(config.buzon, correo.id, correo.huella, VERSION_POLITICA, analisis);
        await this.store.auditar({ buzon: config.buzon, mensajeId: correo.id, tipo: "analisis",
          datos: { huella: correo.huella, resumen: analisis.resumen, recibos: analisis.recibos, completo: analisis.completo,
            otrasAcciones: analisis.otrasAcciones, origen: "observacion_automatica_no_confirmada" } });
      }
      return { correo, analisis, motivos: [] };
    } catch (error) {
      return { correo, motivos: [`error:${mensajeError(error)}`] };
    }
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
      if (op.estado === "completada") return true;
      if (op.estado === "rechazada") return false;
      if (["creando", "adjuntando", "conciliando", "incierta"].includes(op.estado)) {
        // Recuperar un resultado conocido por lectura; nunca repetir el POST que quedó en vuelo.
        const paso = op.pasoIncierto ?? op.estado;
        if (paso === "creando") {
          op.compraId ??= await this.puerto.recuperarCreacion(op);
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
      }
      try {
        if (op.estado === "reservada") {
          const evidencia = await this.puerto.evidencias(c, op.plan.recibo);
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
    const resultado: ResultadoAuto = { modo: config.modo, revisados: 0, completados: 0, simulados: 0, pendientes: [], gastos: [] };
    if (config.modo === "off") return resultado;
    if (!config.buzon) throw new Error("Buzón no configurado.");
    const correos = (await this.puerto.listar()).sort((a, b) => a.recibidoEn - b.recibidoEn || a.id.localeCompare(b.id));
    let analizados = 0;
    await this.opciones.progreso?.({ fase: "analisis", completados: 0, total: correos.length });
    const preparados = await mapearConConcurrencia(correos, this.opciones.concurrenciaAnalisis ?? 2, async correo => {
      const preparado = await this.prepararCorreo(config, correo);
      analizados++;
      await this.opciones.progreso?.({ fase: "analisis", completados: analizados, total: correos.length });
      return preparado;
    });
    const operaciones = await this.store.pendientes(config.buzon);
    // Informar también operaciones cuyo correo fue leído fuera del sistema; nunca desaparecen por ello.
    for (const op of operaciones.filter(o => !correos.some(c => c.id === o.plan.correo.id))) {
      resultado.pendientes.push({ mensajeId: op.plan.correo.id, asunto: `Operación ${op.id}`, motivos: ["operacion_incompleta_fuera_de_no_leidos"] });
    }
    let verificados = 0;
    await this.opciones.progreso?.({ fase: "verificacion", completados: 0, total: preparados.length });
    for (const preparado of preparados) {
      const { correo, analisis } = preparado;
      const motivos = [...preparado.motivos];
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
            if (!op) {
              // Al agotar el presupuesto temporal no se inicia una consulta nueva de Holded ni una
              // escritura. Las operaciones ya reservadas sí continúan para llevarlas a un estado
              // durable y verificable antes de responder.
              if (this.opciones.fechaLimite && Date.now() >= this.opciones.fechaLimite) {
                motivos.push("revision_pospuesta_por_limite_de_tiempo");
                continue;
              }
              const evidencia = await this.puerto.evidencias(correo, recibo);
              const decision = evaluarAuto(correo, analisis, recibo, evidencia, config);
              await this.store.auditar({ buzon: config.buzon, mensajeId: correo.id, tipo: "decision", datos: decision });
              if (!decision.apto) { motivos.push(...decision.motivos); continue; }
              if (config.modo === "simulate") { resultado.simulados++; continue; }
              // No acumular reservas que se bloqueen mutuamente tras un resultado incierto.
              if ((await this.store.pendientes(config.buzon)).some(p => p.plan.empresa === decision.plan.empresa)) {
                motivos.push("empresa_con_operacion_pendiente_de_verificar");
                continue;
              }
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
            } else motivos.push(`operacion_${op.estado}:${op.id}`);
          }
          if (!motivos.length && config.modo === "execute") {
            await this.puerto.marcarResuelto(correo);
            await this.store.auditar({ buzon: config.buzon, mensajeId: correo.id, tipo: "correo_resuelto", datos: { huella: correo.huella } });
          }
          if (config.modo === "simulate") motivos.push("simulacion_sin_modificar_correo");
        }
      } catch (e) { motivos.push(`error:${mensajeError(e)}`); }
      if (motivos.length) resultado.pendientes.push({ mensajeId: correo.id, asunto: correo.asunto, motivos: [...new Set(motivos)] });
      verificados++;
      await this.opciones.progreso?.({ fase: "verificacion", completados: verificados, total: preparados.length });
    }
    await this.store.auditar({ buzon: config.buzon, tipo: "revision_terminada", datos: resultado });
    return resultado;
  }
}

export function resumenAutomatico(r: ResultadoAuto): string {
  if (r.modo === "off") return "";
  const lineas = [r.modo === "simulate" ? "🔎 Simulación de revisión automática terminada." : "📬 Revisión automática terminada.",
    `${r.revisados} mensaje(s) analizado(s); ${r.completados} gasto(s) creado(s) y conciliado(s).`,
    ...(r.modo === "simulate" ? [`${r.simulados} gasto(s) cumplirían los requisitos. No se modificó Holded ni Gmail.`] : []),
    `${r.pendientes.length} mensaje(s) o incidencia(s) pendientes de revisión.`];
  if (r.gastos.length) {
    const porEmpresa = new Map<string, number>();
    for (const g of r.gastos) porEmpresa.set(g.empresa, (porEmpresa.get(g.empresa) ?? 0) + 1);
    lineas.push(`Automatizados por empresa: ${[...porEmpresa].map(([empresa, cantidad]) => `${empresa}: ${cantidad}`).join("; ")}.`);
    lineas.push("Detalle para revisar en Holded y convertir a ticket (etiqueta wobi-ticket-pendiente):");
    for (const g of r.gastos) lineas.push(`• ${g.empresa}: ${(g.centimos / 100).toFixed(2)} ${g.moneda} — compra ${g.id}`);
  }
  const conteo = new Map<string, number>();
  for (const p of r.pendientes) for (const motivo of p.motivos) conteo.set(motivo, (conteo.get(motivo) ?? 0) + 1);
  for (const [motivo, n] of [...conteo].slice(0, 8)) lineas.push(`${n}: ${motivo}`);
  return lineas.join("\n");
}

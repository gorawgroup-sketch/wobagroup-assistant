import { evaluarAuto, type AnalisisAuto, type ConfigAuto, type CorreoAuto, type EvidenciaAuto,
  type OperacionAuto, type PlanAuto, type ReciboAuto, type ResultadoAuto, type StoreAuto, VERSION_POLITICA } from "./model";
import { mapearConConcurrencia } from "../../utils/mapearConConcurrencia";

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
      if (op.estado === "completada" && op.plan.version === VERSION_POLITICA) return true;
      if (op.estado === "rechazada") return false;
      if (op.estado === "completada") {
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
    const correos = (await this.puerto.listar()).sort((a, b) => a.recibidoEn - b.recibidoEn || a.id.localeCompare(b.id));
    let analizados = 0;
    await this.opciones.progreso?.({ fase: "analisis", completados: 0, total: correos.length });
    const preparados = await mapearConConcurrencia(correos, this.opciones.concurrenciaAnalisis ?? 2, async correo => {
      const preparado = await this.prepararCorreo(config, correo);
      analizados++;
      await this.opciones.progreso?.({ fase: "analisis", completados: analizados, total: correos.length });
      return preparado;
    });
    if (config.modo === "execute") {
      const recuperables = await this.store.recuperables(config.buzon, VERSION_POLITICA);
      for (const op of recuperables) {
        const correoNoLeido = correos.find(c => c.id === op.plan.correo.id);
        const debeRecuperarseAhora = op.estado === "completada" || !correoNoLeido;
        if (!debeRecuperarseAhora) continue;
        const correo = correoNoLeido ?? await this.puerto.obtener(op.plan.correo.id, op.plan.correo.threadId);
        if (!correo) {
          resultado.pendientes.push({ mensajeId: op.plan.correo.id, asunto: op.plan.recibo.concepto,
            motivos: ["correo_original_no_disponible"], detalles: [this.detalleOperacion(op, "correo_original_no_disponible")] });
          continue;
        }
        const eraCompletadaAnterior = op.estado === "completada";
        const analisisRecuperado: AnalisisAuto = { resumen: "Recuperación de operación durable existente", completo: true,
          recibos: [op.plan.recibo], otrasAcciones: false };
        if (await this.ejecutar(op, correo, analisisRecuperado, config)) {
          const gasto = { empresa: op.plan.empresa, id: op.compraId!, centimos: op.plan.totalCentimos,
            moneda: op.plan.movimiento.moneda };
          if (eraCompletadaAnterior) resultado.reparados!.push(gasto);
          else { resultado.completados++; resultado.gastos.push(gasto); }
          await this.puerto.registrarFinalizada(op);
        } else if (!correoNoLeido) {
          const motivo = `operacion_${op.estado}:${op.id}`;
          resultado.pendientes.push({ mensajeId: correo.id, asunto: correo.asunto, motivos: [motivo],
            detalles: [this.detalleOperacion(op, motivo)] });
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
  if (tiene("correo_original_no_disponible")) return "La operación existe, pero Gmail ya no permite recuperar el comprobante original.";
  if (motivos.some(motivo => motivo.startsWith("error_automatico:"))) return "La fase automática no terminó y el correo se conserva para revisión manual.";
  return "No se cumplieron todas las condiciones necesarias para automatizarlo con seguridad.";
}

export function resumenAutomatico(r: ResultadoAuto): string {
  if (r.modo === "off") return "";
  const lineas = [r.modo === "simulate" ? "🔎 Simulación de revisión automática terminada." : "📬 Revisión automática terminada.",
    `Correos analizados: ${r.revisados}.`,
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

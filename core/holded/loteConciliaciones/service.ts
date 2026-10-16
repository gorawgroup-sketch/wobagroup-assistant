import { randomUUID } from "node:crypto";
import { conMutex } from "../../utils/asyncMutex";
import type { Empresa } from "../client";
import { claveMovimiento, type PlanConciliacion, type PuertoHolded, type ReferenciaMovimiento } from "../conciliacionMultiple/model";
import type { ServicioConciliacionMultiple } from "../conciliacionMultiple/service";
import {
  clavesBloqueadas, huellaDePeticion, importeDe, loteVigente, motivoDeExclusion, TTL_LOTE, validarEntradaLote,
  type LoteConciliaciones, type ParExcluido, type ParIncluido, type ParSolicitado, type ResultadoPar,
} from "./model";
import type { StoreLotes } from "./store";

/** El motor de planes que usa el lote: el servicio de conciliación múltiple (o un doble en las pruebas). */
export type MotorPlanes = Pick<ServicioConciliacionMultiple, "preparar" | "consultar" | "revalidar" | "decidir">;
export type LectorHolded = Pick<PuertoHolded, "compra" | "movimiento">;

/** Mutex propio del lote: distinto del de la conciliación, que cada plan toma por dentro (los mutex no son reentrantes). */
export const mutexLote = (empresa: Empresa): string => `holded:lote-conciliaciones:${empresa}`;

export class ServicioLoteConciliaciones {
  constructor(
    private readonly motor: MotorPlanes,
    private readonly lector: LectorHolded,
    private readonly store: StoreLotes,
    private readonly ahora = Date.now,
  ) {}

  /**
   * Lee cada par en Holded, deja fuera (con su motivo) los que el lote no cubre y prepara un plan por cada uno de los demás. No escribe
   * en Holded. Si no entra ningún par, falla explicando por qué. Proponer dos veces el mismo lote devuelve el ya propuesto.
   */
  async preparar(datos: { empresa: Empresa; chatId: number; pares: ParSolicitado[]; motivo: string }): Promise<LoteConciliaciones> {
    if (!["WOBA", "EWORKS", "Footprint"].includes(datos.empresa) || !Number.isSafeInteger(datos.chatId)) throw new Error("Empresa o chat inválido.");
    validarEntradaLote(datos.pares, datos.motivo);
    return conMutex(mutexLote(datos.empresa), async () => {
      const huella = datos.pares.map((p) => `${p.compraId}|${p.accountId}/${p.movementId}`).sort().join(",");
      const existentes = await this.store.listar();
      // La MISMA petición (aunque algún par quedara fuera la primera vez) devuelve el lote ya propuesto.
      const igual = existentes.find((l) => l.empresa === datos.empresa && l.estado === "propuesto" && l.chatId === datos.chatId && loteVigente(l, this.ahora()) && huellaDePeticion(l) === huella);
      if (igual) return igual;
      for (const l of existentes.filter((x) => x.empresa === datos.empresa && loteVigente(x, this.ahora()))) {
        const usadas = new Set(clavesBloqueadas(l));
        if (datos.pares.some((p) => usadas.has(`${p.accountId}/${p.movementId}`))) {
          throw new Error(`Un cargo de esta selección ya está en el lote ${l.id} (${l.estado}). Consulta su estado; no repitas la operación.`);
        }
      }
      const id = randomUUID().slice(0, 18);
      const incluidos: ParIncluido[] = [];
      const excluidos: ParExcluido[] = [];
      for (const par of datos.pares) {
        const ref: ReferenciaMovimiento = { accountId: par.accountId, movementId: par.movementId, fecha: par.fecha };
        const clave = claveMovimiento(ref);
        try {
          const compra = await this.lector.compra(datos.empresa, par.compraId);
          if (compra.id !== par.compraId) throw new Error("La compra devuelta no coincide con el ID solicitado.");
          const mov = await this.lector.movimiento(datos.empresa, ref);
          if (claveMovimiento(mov) !== clave || mov.fecha !== par.fecha) throw new Error("El movimiento devuelto no coincide con la selección.");
          const motivoFuera = motivoDeExclusion(compra, mov);
          if (motivoFuera) { excluidos.push({ compraId: par.compraId, movimiento: clave, motivo: motivoFuera }); continue; }
          const plan = await this.planPropio(datos, par.compraId, ref, id, existentes);
          incluidos.push({ compraId: par.compraId, planId: plan.id, proveedor: compra.proveedor, numero: compra.numero, fechaCompra: compra.fecha, importeCentimos: importeDe(compra), moneda: compra.moneda, movimiento: clave, fechaMovimiento: mov.fecha, descripcion: mov.descripcion, cuenta: mov.cuenta });
        } catch (error) {
          excluidos.push({ compraId: par.compraId, movimiento: clave, motivo: error instanceof Error ? error.message : String(error) });
        }
      }
      if (incluidos.length === 0) throw new Error(`Ningún par entra en el lote:\n${excluidos.map((x) => `• ${x.compraId} ↔ ${x.movimiento}: ${x.motivo}`).join("\n")}`);
      const lote: LoteConciliaciones = { id, empresa: datos.empresa, chatId: datos.chatId, creadoEn: this.ahora(), motivo: datos.motivo.trim(), estado: "propuesto", incluidos, excluidos, resultados: [] };
      try { await this.store.guardar(lote); } catch (error) {
        // Sin registro del lote no hay quien apruebe sus planes: se cancelan para que no queden reservando la compra y el cargo.
        const fallos = await this.cancelarPlanes(lote, 0);
        throw new Error(`${error instanceof Error ? error.message : String(error)}${fallos.length ? ` Planes sin cancelar (caducan solos a las 24 h; volver a proponer el mismo lote los limpia): ${fallos.join("; ")}` : ""}`);
      }
      return lote;
    });
  }

  /**
   * Plan del motor para este par que pertenezca a ESTE lote. El motor devuelve el plan ya propuesto si coinciden chat, compra y cargo: si ese plan es
   * de otro flujo (una declaración firmada…) no se adopta ni se toca; si es de un lote que no llegó a registrarse (huérfano) se cancela y se prepara de nuevo.
   */
  private async planPropio(datos: { empresa: Empresa; chatId: number; motivo: string }, compraId: string, ref: ReferenciaMovimiento, loteId: string, lotes: LoteConciliaciones[]): Promise<PlanConciliacion> {
    const preparar = () => this.motor.preparar({ empresa: datos.empresa, chatId: datos.chatId, compraId, movimientos: [ref], motivo: datos.motivo, origen: { tipo: "lote", id: loteId } });
    let plan = await preparar();
    if (plan.origen?.tipo === "lote" && plan.origen.id === loteId) return plan;
    const huerfano = plan.origen?.tipo === "lote" && !lotes.some((l) => l.id === plan.origen!.id);
    if (!huerfano) throw new Error(`el gasto ya tiene un plan propuesto de otro origen (${plan.origen?.tipo ?? "conciliación múltiple"} · ${plan.id}); resuélvelo o cancélalo antes de incluirlo en un lote.`);
    await this.motor.decidir(plan.id, datos.chatId, 0, false);
    plan = await preparar();
    if (!(plan.origen?.tipo === "lote" && plan.origen.id === loteId)) throw new Error("no se pudo preparar un plan propio de este lote para el par.");
    return plan;
  }

  async consultar(id: string, chatId: number): Promise<LoteConciliaciones> {
    const l = (await this.store.listar()).find((x) => x.id === id && x.chatId === chatId);
    if (!l) throw new Error("Lote inexistente o perteneciente a otro chat.");
    return l;
  }

  /** Cancela los planes que no se han ejecutado (desde el índice dado). Un fallo al cancelar uno no impide intentar el resto. */
  private async cancelarPlanes(l: LoteConciliaciones, desde: number): Promise<string[]> {
    const fallos: string[] = [];
    for (const par of l.incluidos.slice(desde)) {
      try { await this.motor.decidir(par.planId, l.chatId, l.aprobadoPor ?? 0, false); }
      catch (error) { fallos.push(`${par.planId}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return fallos;
  }

  async decidir(id: string, chatId: number, usuarioId: number, aprobar: boolean): Promise<LoteConciliaciones> {
    const inicial = await this.consultar(id, chatId);
    return conMutex(mutexLote(inicial.empresa), async () => {
      const l = await this.consultar(id, chatId);
      // Un doble clic, un reinicio o un error de red jamás reanuda ni repite escrituras.
      if (l.estado !== "propuesto") return l;
      if (!Number.isSafeInteger(usuarioId)) throw new Error("Aprobador inválido.");
      l.aprobadoPor = usuarioId;
      if (!aprobar || this.ahora() - l.creadoEn > TTL_LOTE) {
        const fallos = await this.cancelarPlanes(l, 0);
        l.estado = aprobar ? "rechazado" : "cancelado";
        l.detalle = (aprobar ? "La propuesta expiró. Prepara un lote nuevo para revisar los datos actuales." : "Cancelado antes de escribir en Holded.") +
          (fallos.length ? ` No se pudieron cancelar estos planes (caducan solos a las 24 h): ${fallos.join("; ")}` : "");
        await this.store.guardar(l);
        return l;
      }
      // Preflight de TODO el lote: ni una escritura si cualquier par ya no es exactamente lo aprobado.
      const rechazos: string[] = [];
      for (const par of l.incluidos) {
        const r = await this.motor.revalidar(par.planId, chatId).catch((error): { ok: false; motivo: string } => ({ ok: false, motivo: error instanceof Error ? error.message : String(error) }));
        if (!r.ok) rechazos.push(`${par.proveedor} (${par.movimiento}): ${r.motivo}`);
      }
      if (rechazos.length > 0) {
        await this.cancelarPlanes(l, 0);
        l.estado = "rechazado";
        l.detalle = `No se envió ninguna conciliación: ${rechazos.join(" | ")}`;
        await this.store.guardar(l);
        return l;
      }
      l.estado = "ejecutando";
      // Debe persistir ANTES del primer POST. Un fallo de persistencia impide continuar.
      await this.store.guardar(l);
      const resultados: ResultadoPar[] = [];
      let i = 0;
      try {
        for (; i < l.incluidos.length; i++) {
          const par = l.incluidos[i];
          let plan: PlanConciliacion;
          try {
            plan = await this.motor.decidir(par.planId, chatId, usuarioId, true);
          } catch (error) {
            // Una excepción durante la escritura no demuestra que Holded no aplicara el pago.
            resultados.push({ planId: par.planId, estado: "incierto", detalle: error instanceof Error ? error.message : String(error) });
            return await this.detener(l, resultados, i, "incierto", `El par ${i + 1} (${par.proveedor}) falló al ejecutarse; puede haber un pago aplicado.`);
          }
          resultados.push({ planId: par.planId, estado: plan.estado, detalle: plan.detalle ?? plan.estado });
          l.resultados = resultados;
          if (plan.estado !== "completado") {
            const estado = plan.estado === "incierto" || plan.estado === "ejecutando" ? "incierto" : resultados.length === 1 ? "rechazado" : "parcial";
            return await this.detener(l, resultados, i, estado, `El lote se detuvo en el par ${i + 1} (${par.proveedor}): ${plan.estado}.`);
          }
          await this.store.guardar(l);
        }
      } catch (error) {
        // Fallo del propio registro del lote entre dos pares: lo ya conciliado queda (cada plan lo verificó), lo demás NO se envía y se dice con claridad.
        if (l.estado !== "ejecutando") throw error;
        return this.detener(l, resultados, Math.min(i, l.incluidos.length - 1), "incierto", `El registro del lote falló tras el par ${i + 1}: ${error instanceof Error ? error.message : String(error)}.`);
      }
      l.resultados = resultados;
      l.estado = "completado";
      l.detalle = `Los ${l.incluidos.length} pares quedaron conciliados y verificados uno a uno contra Holded (pago, cuenta, fecha, importe y saldo del gasto).`;
      await this.store.guardar(l);
      return l;
    });
  }

  /** Detiene el lote en el par `i`: los siguientes se cancelan sin escribir y quedan anotados como no ejecutados. */
  private async detener(l: LoteConciliaciones, resultados: ResultadoPar[], i: number, estado: LoteConciliaciones["estado"], detalle: string): Promise<LoteConciliaciones> {
    const pendientes = l.incluidos.slice(i + 1);
    const fallos = await this.cancelarPlanes(l, i + 1);
    for (const par of pendientes) if (!resultados.some((r) => r.planId === par.planId)) resultados.push({ planId: par.planId, estado: "no_ejecutado", detalle: "No se envió: el lote se detuvo antes." });
    l.resultados = resultados;
    l.estado = estado;
    l.detalle = `${detalle}${pendientes.length ? ` Los ${pendientes.length} par(es) siguientes NO se enviaron.` : ""}${fallos.length ? ` No se pudieron cancelar: ${fallos.join("; ")}` : ""}`;
    await this.store.guardar(l);
    return l;
  }
}

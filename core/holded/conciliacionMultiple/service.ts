import { randomUUID } from "node:crypto";
import { conMutex } from "../../utils/asyncMutex";
import type { Empresa } from "../client";
import {
  claveMovimiento, mutexConciliacion, reservaActiva, TTL_PLAN, validarCompra, validarReferencia, validarSeleccion,
  type CompraExacta, type MovimientoExacto, type PlanConciliacion, type PuertoHolded, type ReferenciaMovimiento, type StorePlanes,
} from "./model";

function identidadCompra(c: CompraExacta): string {
  return JSON.stringify([c.id, c.proveedorId, c.proveedor, c.numero, c.fecha, c.moneda, c.totalCentimos, c.borrador, c.cuentasContables]);
}
function mismosPagos(a: CompraExacta, b: CompraExacta): boolean {
  const ordenar = (c: CompraExacta) => [...c.pagos].sort((x, y) => x.id.localeCompare(y.id));
  return JSON.stringify(ordenar(a)) === JSON.stringify(ordenar(b));
}
function comprobarCompra(esperada: CompraExacta, actual: CompraExacta): void {
  validarCompra(actual);
  if (identidadCompra(esperada) !== identidadCompra(actual) || esperada.pagadoCentimos !== actual.pagadoCentimos ||
      esperada.pendienteCentimos !== actual.pendienteCentimos || !mismosPagos(esperada, actual)) {
    throw new Error("La compra o sus pagos cambiaron desde la aprobación.");
  }
}
function comprobarMovimiento(esperado: MovimientoExacto, actual: MovimientoExacto, conciliado = false): void {
  const identidad = (m: MovimientoExacto) => JSON.stringify([m.accountId, m.movementId, m.fecha, m.centimos, m.moneda, m.descripcion, m.cuenta]);
  if (identidad(esperado) !== identidad(actual)) throw new Error("Cambió un movimiento seleccionado.");
  if (conciliado) {
    if (!["reconciled", "forced_reconciled"].includes(actual.estado) || actual.conciliadoCentimos !== esperado.centimos) {
      throw new Error("No se verificó la conciliación íntegra del movimiento.");
    }
  } else if (actual.estado !== "pending" || actual.conciliadoCentimos !== 0) {
    throw new Error("El movimiento ya no está libre para conciliar.");
  }
}

export class ServicioConciliacionMultiple {
  constructor(private readonly holded: PuertoHolded, private readonly store: StorePlanes, private readonly ahora = Date.now) {}

  async preparar(datos: { empresa: Empresa; chatId: number; compraId: string; movimientos: ReferenciaMovimiento[]; motivo: string }): Promise<PlanConciliacion> {
    if (!["WOBA", "EWORKS", "Footprint"].includes(datos.empresa) || !Number.isSafeInteger(datos.chatId)) throw new Error("Empresa o chat inválido.");
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(datos.compraId)) throw new Error("Identifica la compra por su ID real de Holded.");
    if (!Array.isArray(datos.movimientos) || datos.movimientos.length < 2 || datos.movimientos.length > 20) throw new Error("Selecciona de 2 a 20 movimientos.");
    datos.movimientos.forEach(validarReferencia);
    if (!datos.motivo?.trim() || datos.motivo.length > 500) throw new Error("Indica el motivo que vincula estos pagos con la compra (hasta 500 caracteres).");
    return conMutex(mutexConciliacion(datos.empresa), async () => {
      const planes = await this.store.listar();
      const claves = datos.movimientos.map(claveMovimiento).sort();
      for (const p of planes.filter((p) => p.empresa === datos.empresa && reservaActiva(p, this.ahora()))) {
        if (p.compra.id !== datos.compraId && !p.movimientos.some((m) => claves.includes(claveMovimiento(m)))) continue;
        if (p.estado === "propuesto" && p.chatId === datos.chatId && p.compra.id === datos.compraId &&
            JSON.stringify(p.movimientos.map(claveMovimiento).sort()) === JSON.stringify(claves)) return p;
        throw new Error(`La compra o un movimiento ya están reservados por el plan ${p.id} (${p.estado}). Consulta su estado; no repitas la operación.`);
      }
      const compra = await this.holded.compra(datos.empresa, datos.compraId);
      if (compra.id !== datos.compraId) throw new Error("La compra devuelta no coincide con el ID solicitado.");
      const movimientos: MovimientoExacto[] = [];
      for (const ref of datos.movimientos) {
        const m = await this.holded.movimiento(datos.empresa, ref);
        if (claveMovimiento(m) !== claveMovimiento(ref) || m.fecha !== ref.fecha) throw new Error("El movimiento devuelto no coincide con la selección.");
        movimientos.push(m);
      }
      validarSeleccion(compra, movimientos);
      await this.holded.validarClasificacion(datos.empresa, compra.id);
      const plan: PlanConciliacion = {
        id: randomUUID().slice(0, 18), empresa: datos.empresa, chatId: datos.chatId, creadoEn: this.ahora(),
        compra, movimientos, motivo: datos.motivo.trim(), estado: "propuesto", verificados: [], pagosVerificados: [],
      };
      await this.store.guardar(plan);
      return plan;
    });
  }

  async consultar(id: string, chatId: number): Promise<PlanConciliacion> {
    const p = (await this.store.listar()).find((p) => p.id === id && p.chatId === chatId);
    if (!p) throw new Error("Plan inexistente o perteneciente a otro chat.");
    return p;
  }

  async decidir(id: string, chatId: number, usuarioId: number, aprobar: boolean): Promise<PlanConciliacion> {
    const inicial = await this.consultar(id, chatId);
    return conMutex(mutexConciliacion(inicial.empresa), async () => {
      const p = await this.consultar(id, chatId);
      // Un reinicio, doble clic o error de red jamás reanuda ni repite escrituras.
      if (p.estado !== "propuesto") return p;
      if (!Number.isSafeInteger(usuarioId)) throw new Error("Aprobador inválido.");
      p.aprobadoPor = usuarioId;
      if (!aprobar || this.ahora() - p.creadoEn > TTL_PLAN) {
        p.estado = aprobar ? "rechazado" : "cancelado";
        p.detalle = aprobar ? "La propuesta expiró. Prepara una nueva para revisar datos actuales." : "Cancelado antes de escribir en Holded.";
        await this.store.guardar(p);
        return p;
      }
      try {
        // Preflight completo: ni una escritura si falla cualquiera de las referencias.
        validarSeleccion(p.compra, p.movimientos);
        await this.holded.validarClasificacion(p.empresa, p.compra.id);
        comprobarCompra(p.compra, await this.holded.compra(p.empresa, p.compra.id));
        for (const m of p.movimientos) comprobarMovimiento(m, await this.holded.movimiento(p.empresa, m));
      } catch (error) {
        p.estado = "rechazado";
        p.detalle = `No se envió ninguna conciliación: ${error instanceof Error ? error.message : String(error)}`;
        await this.store.guardar(p);
        return p;
      }
      p.estado = "ejecutando";
      // Debe persistir ANTES del primer POST. Un fallo de persistencia impide continuar.
      await this.store.guardar(p);
      let esperada = p.compra;
      try {
        for (const m of p.movimientos) {
          comprobarCompra(esperada, await this.holded.compra(p.empresa, p.compra.id));
          comprobarMovimiento(m, await this.holded.movimiento(p.empresa, m));
          await this.holded.validarClasificacion(p.empresa, p.compra.id);
          p.enVuelo = claveMovimiento(m);
          await this.store.guardar(p);
          await this.holded.conciliar(p.empresa, m, p.compra.id);
          comprobarMovimiento(m, await this.holded.movimiento(p.empresa, m), true);
          const despues = await this.holded.compra(p.empresa, p.compra.id);
          validarCompra(despues);
          const aplicado = -m.centimos;
          const nuevos = despues.pagos.filter((pago) => !esperada.pagos.some((anterior) => anterior.id === pago.id));
          const anterioresIntactos = esperada.pagos.every((anterior) => despues.pagos.some((pago) => JSON.stringify(pago) === JSON.stringify(anterior)));
          if (identidadCompra(despues) !== identidadCompra(esperada) ||
              despues.pendienteCentimos !== esperada.pendienteCentimos - aplicado ||
              despues.pagadoCentimos !== esperada.pagadoCentimos + aplicado || !anterioresIntactos ||
              nuevos.length !== 1 || nuevos[0].centimos !== aplicado || nuevos[0].accountId !== m.accountId || nuevos[0].fecha !== m.fecha) {
            throw new Error("El pago nuevo, su cuenta/fecha o la variación del saldo de compra no coinciden exactamente.");
          }
          p.verificados.push(claveMovimiento(m));
          p.pagosVerificados.push({ movimiento: claveMovimiento(m), pago: nuevos[0], pendienteCentimos: despues.pendienteCentimos });
          p.enVuelo = undefined;
          await this.store.guardar(p);
          esperada = despues;
        }
        // Relectura final de AMBOS lados, también de los primeros movimientos del lote.
        comprobarCompra(esperada, await this.holded.compra(p.empresa, p.compra.id));
        for (const m of p.movimientos) comprobarMovimiento(m, await this.holded.movimiento(p.empresa, m), true);
        if (esperada.pendienteCentimos !== 0) throw new Error("La compra conserva saldo pendiente.");
        p.estado = "completado";
        p.detalle = "Todos los movimientos y pagos verificados; saldo pendiente de compra: 0.00 EUR.";
        await this.store.guardar(p);
        return p;
      } catch (error) {
        p.estado = "incierto";
        p.detalle = `Lote detenido: ${error instanceof Error ? error.message : String(error)}. ` +
          "Puede haber escrituras aplicadas. No repetir ni marcar como resuelto; revisar el plan y Holded.";
        // Si también falla esto, queda persistido ejecutando/enVuelo, que igualmente bloquea reintentos.
        await this.store.guardar(p);
        return p;
      }
    });
  }
}

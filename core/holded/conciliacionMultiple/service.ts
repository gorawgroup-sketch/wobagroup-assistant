import { randomUUID } from "node:crypto";
import { conMutex } from "../../utils/asyncMutex";
import type { Empresa } from "../client";
import {
  claveMovimiento, esDivisaExtranjera, importe, margenResiduoCentimos, mutexConciliacion, reservaActiva, TTL_PLAN, validarCompra, validarReferencia, validarSeleccion,
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
  // Los planes guardados antes de existir `contableCentimos` no lo traen: entonces solo se compara el resto de la identidad.
  const identidad = (m: MovimientoExacto) => JSON.stringify([m.accountId, m.movementId, m.fecha, m.centimos, m.moneda, m.descripcion, m.cuenta,
    esperado.contableCentimos === undefined ? null : (m.contableCentimos ?? null)]);
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
        compra, compraInicial: compra, movimientos, motivo: datos.motivo.trim(), estado: "propuesto", verificados: [], pagosVerificados: [],
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
      // Tras reanudar un lote detenido, los movimientos ya verificados no se vuelven a enviar: solo se comprueba que siguen conciliados.
      const hechos = p.movimientos.filter((m) => p.verificados.includes(claveMovimiento(m)));
      const restantes = p.movimientos.filter((m) => !p.verificados.includes(claveMovimiento(m)));
      const reanudado = hechos.length > 0;
      try {
        // Preflight completo: ni una escritura si falla cualquiera de las referencias.
        if (restantes.length > 0) validarSeleccion(p.compra, restantes, { recuperacion: reanudado });
        else validarCompra(p.compra);
        await this.holded.validarClasificacion(p.empresa, p.compra.id);
        comprobarCompra(p.compra, await this.holded.compra(p.empresa, p.compra.id));
        for (const m of hechos) comprobarMovimiento(m, await this.holded.movimiento(p.empresa, m), true);
        for (const m of restantes) comprobarMovimiento(m, await this.holded.movimiento(p.empresa, m));
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
        const divisa = esDivisaExtranjera(p.compra);
        for (const m of restantes) {
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
          // EUR: aritmética exacta. Divisa: el pago nuevo debe valer el equivalente en EUR del movimiento y el saldo nativo bajar lo que
          // el movimiento, salvo el redondeo de Holded (margen estándar); el residuo se cierra al final con el ajuste de cambio.
          const margen = margenResiduoCentimos(p.compra.totalCentimos);
          const saldoOk = divisa
            ? Math.abs((esperada.pendienteCentimos - despues.pendienteCentimos) - aplicado) <= margen &&
              Math.abs((despues.pagadoCentimos - esperada.pagadoCentimos) - aplicado) <= margen
            : despues.pendienteCentimos === esperada.pendienteCentimos - aplicado && despues.pagadoCentimos === esperada.pagadoCentimos + aplicado;
          const importePagoEsperado = divisa ? m.contableCentimos : aplicado;
          if (identidadCompra(despues) !== identidadCompra(esperada) || !saldoOk || !anterioresIntactos ||
              nuevos.length !== 1 || nuevos[0].centimos !== importePagoEsperado || nuevos[0].accountId !== m.accountId || nuevos[0].fecha !== m.fecha) {
            throw new Error("El pago nuevo, su cuenta/fecha o la variación del saldo de compra no coinciden con lo esperado.");
          }
          p.verificados.push(claveMovimiento(m));
          p.pagosVerificados.push({ movimiento: claveMovimiento(m), pago: nuevos[0], pendienteCentimos: despues.pendienteCentimos });
          p.enVuelo = undefined;
          await this.store.guardar(p);
          esperada = despues;
        }
        // Divisa: lo que queda es el residuo de redondeo de Holded. Se cierra una sola vez con el ajuste de cambio durable
        // (su propia idempotencia evita repetirlo si el proceso se interrumpe aquí) y se relee la compra.
        if (divisa && esperada.pendienteCentimos !== 0) {
          p.enVuelo = "ajuste-cambio";
          await this.store.guardar(p);
          const cierre = await this.holded.cerrarResiduoCambio(p.empresa, p.compra.id, p.movimientos[p.movimientos.length - 1]);
          p.ajusteCambio = { estado: cierre.estado, montoCentimos: cierre.montoCentimos, motivo: cierre.motivo };
          if (cierre.estado !== "aplicado" && cierre.estado !== "ya_aplicado" && cierre.estado !== "sin_residuo") {
            throw new Error(`El residuo de cambio no se cerró (${cierre.estado}): ${cierre.motivo}`);
          }
          p.enVuelo = undefined;
          await this.store.guardar(p);
          esperada = await this.holded.compra(p.empresa, p.compra.id);
          validarCompra(esperada);
        }
        // Relectura final de AMBOS lados, también de los primeros movimientos del lote.
        comprobarCompra(esperada, await this.holded.compra(p.empresa, p.compra.id));
        for (const m of p.movimientos) comprobarMovimiento(m, await this.holded.movimiento(p.empresa, m), true);
        if (esperada.pendienteCentimos !== 0) throw new Error(`La compra conserva saldo pendiente (${importe(esperada.pendienteCentimos)} ${esperada.moneda}).`);
        p.estado = "completado";
        p.detalle = "Todos los movimientos y pagos verificados; saldo pendiente de compra: 0.00." +
          (p.ajusteCambio && p.ajusteCambio.montoCentimos > 0 ? ` Residuo de redondeo de la divisa cerrado con el ajuste de cambio de ${importe(p.ajusteCambio.montoCentimos)} EUR.` : "");
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

  /**
   * Reanuda un lote detenido (estado incierto/ejecutando) sin repetir ningún pago: relee Holded, DEMUESTRA qué movimientos ya
   * están conciliados con su pago exacto en esta compra (cuenta, fecha e importe) y deja el plan de nuevo «propuesto» solo con
   * lo que falta, para que el superadministrador lo apruebe con el mismo botón. Cualquier pago o movimiento que no se pueda
   * explicar por el plan aborta: la reanudación nunca adivina.
   */
  async reanudar(id: string, chatId: number): Promise<PlanConciliacion> {
    const inicial = await this.consultar(id, chatId);
    return conMutex(mutexConciliacion(inicial.empresa), async () => {
      const p = await this.consultar(id, chatId);
      if (p.estado !== "incierto" && p.estado !== "ejecutando") {
        throw new Error(`El plan está ${p.estado}; solo se reanuda un lote detenido (incierto o ejecutando).`);
      }
      const actual = await this.holded.compra(p.empresa, p.compra.id);
      validarCompra(actual);
      const base = p.compraInicial ?? p.compra;
      if (identidadCompra(base) !== identidadCompra(actual)) throw new Error("La compra cambió de identidad desde la aprobación.");
      const divisa = esDivisaExtranjera(actual);
      const libres: string[] = [];
      const hechos: PlanConciliacion["pagosVerificados"] = [];
      const pagosExplicados = new Set<string>();
      for (const anterior of base.pagos) {
        if (!actual.pagos.some((pago) => JSON.stringify(pago) === JSON.stringify(anterior))) throw new Error("Un pago anterior al plan cambió o desapareció.");
        pagosExplicados.add(anterior.id);
      }
      for (let i = 0; i < p.movimientos.length; i++) {
        const m = p.movimientos[i];
        const ahora = await this.holded.movimiento(p.empresa, m);
        // Plan antiguo sin el equivalente en EUR: se incorpora el que Holded informa ahora (la identidad del resto ya se comprueba abajo).
        if (m.contableCentimos === undefined && ahora.contableCentimos !== undefined) p.movimientos[i] = { ...m, contableCentimos: ahora.contableCentimos };
        const importeEsperado = divisa ? p.movimientos[i].contableCentimos : -m.centimos;
        try { comprobarMovimiento(m, ahora, true); } catch {
          comprobarMovimiento(m, ahora); // si tampoco está libre, lanza: estado ambiguo, no se adivina.
          libres.push(claveMovimiento(m));
          continue;
        }
        const pagos = actual.pagos.filter((pago) => !pagosExplicados.has(pago.id) &&
          pago.accountId === m.accountId && pago.fecha === m.fecha && pago.centimos === importeEsperado);
        if (pagos.length !== 1) throw new Error(`El movimiento ${claveMovimiento(m)} figura conciliado pero no hay exactamente un pago que lo explique en la compra.`);
        pagosExplicados.add(pagos[0].id);
        hechos.push({ movimiento: claveMovimiento(m), pago: pagos[0], pendienteCentimos: actual.pendienteCentimos });
      }
      const sinExplicar = actual.pagos.filter((pago) => !pagosExplicados.has(pago.id));
      if (sinExplicar.length > 0 && !(p.enVuelo === "ajuste-cambio" || p.ajusteCambio)) {
        throw new Error("La compra tiene pagos que el plan no explica; requiere revisión manual.");
      }
      if (sinExplicar.length > 1) throw new Error("La compra tiene más de un pago ajeno al plan; requiere revisión manual.");
      p.compraInicial = base;
      p.compra = actual;
      p.verificados = hechos.map((h) => h.movimiento);
      p.pagosVerificados = hechos;
      p.enVuelo = undefined;
      p.aprobadoPor = undefined;
      p.creadoEn = this.ahora();
      if (libres.length === 0 && actual.pendienteCentimos === 0) {
        p.estado = "completado";
        p.detalle = "Reanudado: todos los movimientos y pagos ya estaban verificados; saldo pendiente 0.00.";
      } else {
        p.estado = "propuesto";
        p.detalle = `Reanudado tras un lote detenido: ${hechos.length} movimiento(s) ya conciliado(s) y verificado(s) en Holded; ` +
          `faltan ${libres.length}. Saldo pendiente actual: ${importe(actual.pendienteCentimos)} ${actual.moneda}.`;
      }
      await this.store.guardar(p);
      return p;
    });
  }
}

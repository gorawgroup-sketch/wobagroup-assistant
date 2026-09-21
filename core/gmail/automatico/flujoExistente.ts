import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { adjuntarComprobanteHolded, crearGastoHolded, editarCompraHolded, inferirCuentaGasto,
  combinarTagsGastoAprendidos, reconciliarMovimiento, tieneCategoriaGastoAprendida } from "../../holded/write";
import { conTiempoMaximo } from "../../utils/asyncTimeout";
import type { FlujoGastoExistente } from "./holded";
import { monedaRegistroPlanAuto, VERSION_POLITICA, type OperacionAuto, type ReciboAuto } from "./model";
import { conciliacionRequiereRevision } from "../../holded/durableBankReconciliation";

async function clasificar(recibo: ReciboAuto, excluirCompraId?: string) {
  if (recibo.empresa === "desconocida") return undefined;
  const textoClasificacion = [recibo.concepto, recibo.contextoClasificacion].filter(Boolean).join(" · ");
  const sugerencia = await conTiempoMaximo(() => inferirCuentaGasto(recibo.empresa as Exclude<ReciboAuto["empresa"], "desconocida">, {
    proveedor: recibo.proveedor, concepto: textoClasificacion, personaAsociada: recibo.persona,
    contextoDeViaje: recibo.viaje, reciboSimplificado: true, excluirCompraId,
  }), 60_000, "clasificación contable automática");
  if (!sugerencia?.accountId) return undefined;
  const tags = combinarTagsGastoAprendidos(
    recibo.concepto,
    recibo.proveedor,
    recibo.persona,
    sugerencia.tags,
    recibo.contextoClasificacion
  );
  return { cuentaId: sugerencia.accountId, nombreCuenta: sugerencia.accountId, tags,
    evidencia: `${sugerencia.aprendidoDe}: ${sugerencia.ejemplo}` };
}

async function asegurarClasificacion(op: OperacionAuto) {
  const guardada = op.plan.evidencia.cuenta;
  // Los planes de políticas anteriores pueden contener precisamente la cuenta y
  // los tags defectuosos que estamos reparando. Solo la política actual puede
  // reutilizar su clasificación; las anteriores vuelven a pasar por el mismo
  // aprendizaje compartido del flujo uno a uno, excluyendo su propio borrador.
  const resultado = op.plan.version === VERSION_POLITICA && guardada?.id && Array.isArray(guardada.tags)
    ? { cuentaId: guardada.id, nombreCuenta: guardada.nombre ?? guardada.id,
        tags: guardada.tags, evidencia: guardada.evidencia }
    : await clasificar(op.plan.recibo, op.compraId);
  if (!resultado) throw new Error("cuenta_contable_no_verificada");
  op.plan.cuentaId = resultado.cuentaId;
  op.plan.evidencia.cuenta = { id: resultado.cuentaId, nombre: resultado.nombreCuenta,
    tags: resultado.tags, evidencia: resultado.evidencia };
  return resultado;
}

/**
 * Autoriza una conciliación entre monedas solo cuando el propio plan conserva
 * una cifra verificable en la moneda del movimiento o el equivalente contable
 * oficial que Holded devolvió para ese movimiento. No se calcula ningún tipo
 * de cambio ni se confía en una aproximación generada por el modelo.
 */
export function conciliacionMultimonedaDemostrada(op: OperacionAuto): boolean {
  const p = op.plan;
  const documento = monedaRegistroPlanAuto(p);
  if (documento.moneda.toUpperCase().trim() === p.movimiento.moneda.toUpperCase().trim()) return false;
  const equivalenteExplicito = p.recibo.equivalente;
  const porEquivalenteExplicito = Boolean(equivalenteExplicito &&
    equivalenteExplicito.moneda.toUpperCase().trim() === p.movimiento.moneda.toUpperCase().trim() &&
    Math.abs(Math.round(equivalenteExplicito.monto * 100) - p.totalCentimos) <= p.toleranciaCentimos);
  const porContabilidadHolded = p.movimiento.monedaContable?.toUpperCase().trim() ===
      (equivalenteExplicito?.moneda ?? p.recibo.moneda).toUpperCase().trim() &&
    Number.isSafeInteger(p.movimiento.contabilidadCentimos) &&
    Math.abs(Math.abs(p.movimiento.contabilidadCentimos!) - p.totalCentimos) <= p.toleranciaCentimos;
  return porEquivalenteExplicito || porContabilidadHolded;
}

/** Una relectura puede no recuperar el número aunque el documento ya lo tenga.
 * En una reparación solo se envía un número demostrado; si falta, el editor
 * compartido conserva el valor actual de Holded en vez de degradarlo a 00000. */
export function camposDocumentoParaReparacion(recibo: ReciboAuto): { fecha: string; numeroDocumento?: string } {
  const numeroDocumento = recibo.numero?.trim();
  return { fecha: recibo.fecha, ...(numeroDocumento ? { numeroDocumento } : {}) };
}

/** Una clasificación parcial nunca debe borrar categorías ya verificadas. */
export function camposEtiquetasParaReparacion(tags: string[]): { tagsNuevos?: string[] } {
  return tieneCategoriaGastoAprendida(tags) ? { tagsNuevos: tags } : {};
}

export function crearFlujoGastoExistente(): FlujoGastoExistente {
  const conciliar = async (op: OperacionAuto) => {
    if (!op.compraId) throw new Error("Compra ausente antes de conciliar.");
    const p = op.plan;
    return reconciliarMovimiento(p.empresa, p.movimiento.cuentaId, p.movimiento.id,
      p.movimiento.fecha, op.compraId, { permitirMonedaDistinta: conciliacionMultimonedaDemostrada(op) });
  };
  return {
    clasificar,
    crear: async (op) => {
      const cuenta = await asegurarClasificacion(op);
      const p = op.plan;
      const documento = monedaRegistroPlanAuto(p);
      const descripcion = documento.moneda === p.recibo.moneda
        ? p.recibo.concepto
        : `${p.recibo.concepto} (comprobante original ${p.recibo.monto} ${p.recibo.moneda})`;
      const resultado = await crearGastoHolded(p.empresa, { contactId: p.contactoId, fecha: p.recibo.fecha,
        descripcion,
        lineas: [{ concepto: descripcion, base: documento.monto, tipoIvaPct: 0,
          tratamientoFiscal: "inversion_sujeto_pasivo" }], cuentaId: cuenta.cuentaId, tags: cuenta.tags,
        moneda: documento.moneda, tasaCambio: documento.tasaCambio, numeroDocumento: p.recibo.numero },
      { idempotencyKey: `correo-auto:${op.id}`, proceso: "correo_gasto_automatico" });
      return resultado.id;
    },
    corregir: async (op, compraId) => {
      const cuenta = await asegurarClasificacion(op);
      const documento = monedaRegistroPlanAuto(op.plan);
      const concepto = documento.moneda === op.plan.recibo.moneda
        ? op.plan.recibo.concepto
        : `${op.plan.recibo.concepto} (comprobante original ${op.plan.recibo.monto} ${op.plan.recibo.moneda})`;
      await editarCompraHolded(op.plan.empresa, compraId,
        { contactoIdNuevo: op.plan.contactoId, cuentaIdNueva: cuenta.cuentaId,
          ...camposEtiquetasParaReparacion(cuenta.tags),
          ...camposDocumentoParaReparacion(op.plan.recibo),
          ...(documento.moneda === "EUR" || documento.tasaCambio !== undefined
            ? { monedaNueva: documento.moneda, tasaCambioNueva: documento.tasaCambio ?? 1 }
            : {}),
          lineas: [{ concepto, base: documento.monto, tipoIvaPct: 0,
            tratamientoFiscal: "inversion_sujeto_pasivo" }] },
        // Cada política de reparación tiene su propia frontera durable. Una edición
        // anterior incierta jamás se repite; la política nueva relee el estado actual
        // completo y puede aplicar una corrección distinta con otra identidad.
        { idempotencyKey: `correo-auto-reparar:${op.id}:${VERSION_POLITICA}`,
          proceso: "correo_gasto_automatico_reparar" });
    },
    adjuntar: async (op, data, nombre, mime) => {
      if (!op.compraId) throw new Error("Compra ausente antes de adjuntar.");
      const carpeta = await mkdtemp(join(tmpdir(), "wobi-auto-"));
      const ruta = join(carpeta, basename(nombre).replace(/[^a-zA-Z0-9._-]+/g, "_") || "comprobante.bin");
      try {
        await writeFile(ruta, data);
        await adjuntarComprobanteHolded(op.plan.empresa, op.compraId, ruta, basename(ruta), mime,
          { idempotencyKey: `correo-auto-adjunto:${op.id}`, proceso: "correo_gasto_automatico" });
      } finally { await rm(carpeta, { recursive: true, force: true }); }
    },
    conciliar: async (op) => {
      const resultado = await conciliar(op);
      if (!resultado.ok || conciliacionRequiereRevision(resultado)) {
        throw new Error(`Conciliación no confirmada al 100 %: ${resultado.statusFinal}.`);
      }
    },
    verificarConciliacion: async (op) => {
      const resultado = await conciliar(op);
      return resultado.ok && !conciliacionRequiereRevision(resultado);
    },
  };
}

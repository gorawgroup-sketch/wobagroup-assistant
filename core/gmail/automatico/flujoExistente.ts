import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { adjuntarComprobanteHolded, crearGastoHolded, editarCompraHolded, inferirCuentaGasto,
  combinarTagsGastoAprendidos, reconciliarMovimiento } from "../../holded/write";
import type { FlujoGastoExistente } from "./holded";
import { VERSION_POLITICA, type OperacionAuto, type ReciboAuto } from "./model";

async function clasificar(recibo: ReciboAuto, excluirCompraId?: string) {
  if (recibo.empresa === "desconocida") return undefined;
  const sugerencia = await inferirCuentaGasto(recibo.empresa, { proveedor: recibo.proveedor,
    concepto: recibo.concepto, personaAsociada: recibo.persona, contextoDeViaje: recibo.viaje,
    reciboSimplificado: true, excluirCompraId });
  if (!sugerencia?.accountId) return undefined;
  const tags = combinarTagsGastoAprendidos(
    recibo.concepto,
    recibo.proveedor,
    recibo.persona,
    sugerencia.tags
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

export function crearFlujoGastoExistente(): FlujoGastoExistente {
  const conciliar = async (op: OperacionAuto) => {
    if (!op.compraId) throw new Error("Compra ausente antes de conciliar.");
    const p = op.plan;
    return reconciliarMovimiento(p.empresa, p.movimiento.cuentaId, p.movimiento.id,
      p.movimiento.fecha, op.compraId);
  };
  return {
    clasificar,
    crear: async (op) => {
      const cuenta = await asegurarClasificacion(op);
      const p = op.plan;
      const resultado = await crearGastoHolded(p.empresa, { contactId: p.contactoId, fecha: p.recibo.fecha,
        descripcion: p.recibo.concepto,
        lineas: [{ concepto: p.recibo.concepto, base: p.totalCentimos / 100, tipoIvaPct: 0,
          tratamientoFiscal: "sin_impuesto" }], cuentaId: cuenta.cuentaId, tags: cuenta.tags,
        moneda: p.movimiento.moneda, numeroDocumento: p.recibo.numero },
      { idempotencyKey: `correo-auto:${op.id}`, proceso: "correo_gasto_automatico" });
      return resultado.id;
    },
    corregir: async (op, compraId) => {
      const cuenta = await asegurarClasificacion(op);
      await editarCompraHolded(op.plan.empresa, compraId,
        { cuentaIdNueva: cuenta.cuentaId, tagsNuevos: cuenta.tags },
        { idempotencyKey: `correo-auto-reparar:${op.id}`, proceso: "correo_gasto_automatico_reparar" });
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
      if (!resultado.ok) throw new Error(`Conciliación no confirmada: ${resultado.statusFinal}.`);
    },
    verificarConciliacion: async (op) => (await conciliar(op)).ok,
  };
}

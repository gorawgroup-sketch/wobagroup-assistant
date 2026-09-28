import assert from "node:assert/strict";
import test from "node:test";
import type { RegistroConciliacionMovimiento } from "./durableBankReconciliation";
import { EDAD_MINIMA_INCIERTA_MS, verificarAusenciaDeEfectoPorLectura } from "./revertirConciliacionIncierta";

const AHORA = 10_000_000;
const registro = (cambios: Partial<RegistroConciliacionMovimiento> = {}): RegistroConciliacionMovimiento => ({
  clave: "c".repeat(64), proceso: "conciliacion_movimiento_aprobada", estado: "incierta", empresa: "Footprint",
  accountId: "cuenta", movementId: "mov", documentId: "doc", fechaAproximada: "2026-09-23",
  huellaSolicitud: "h", creadoEn: 1, actualizadoEn: AHORA - EDAD_MINIMA_INCIERTA_MS - 1, ...cambios,
});
const deps = (compra: Record<string, unknown>, movimiento: Record<string, unknown> | undefined) => ({
  leerCompra: async () => compra as any,
  leerMovimiento: async () => movimiento as any,
});
const compraSinPagos = { payments_total: "0,00", payments_detail: [] as unknown[] };
const movimientoLibre = { status: "pending", reconciled_amount: "0.00" };

test("demuestra la ausencia de efecto: compra sin pagos y cargo pendiente sin importe conciliado", async () => {
  const r = await verificarAusenciaDeEfectoPorLectura(registro(), AHORA, deps(compraSinPagos, movimientoLibre));
  assert.equal(r.ok, true);
  assert.match(r.motivo, /verificado por lectura/);
});

test("no revierte si hay cualquier indicio de efecto o duda", async () => {
  const casos: Array<[string, Parameters<typeof deps>[0], Parameters<typeof deps>[1], Partial<RegistroConciliacionMovimiento>?]> = [
    ["compra con pagos", { ...compraSinPagos, payments_detail: [{ amount: "4.57" }] }, movimientoLibre],
    ["pagado distinto de cero", { ...compraSinPagos, payments_total: "4,57" }, movimientoLibre],
    ["pagado ausente", { payments_detail: [] }, movimientoLibre],
    ["cargo conciliado", compraSinPagos, { status: "reconciled", reconciled_amount: "-4.57" }],
    ["cargo parcial", compraSinPagos, { status: "partial", reconciled_amount: "-2.00" }],
    ["cargo inexistente", compraSinPagos, undefined],
    ["registro que no está incierto", compraSinPagos, movimientoLibre, { estado: "verificada_revision" }],
    ["incierto hace menos de 5 minutos", compraSinPagos, movimientoLibre, { actualizadoEn: AHORA - 60_000 }],
  ];
  for (const [nombre, compra, movimiento, cambios] of casos) {
    const r = await verificarAusenciaDeEfectoPorLectura(registro(cambios), AHORA, deps(compra, movimiento));
    assert.equal(r.ok, false, nombre);
  }
});

test("un fallo de lectura de Holded nunca se interpreta como ausencia de efecto", async () => {
  const r = await verificarAusenciaDeEfectoPorLectura(registro(), AHORA, {
    leerCompra: async () => { throw new Error("429 Too Many Requests"); },
    leerMovimiento: async () => movimientoLibre as any,
  });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /No se pudo leer Holded/);
});

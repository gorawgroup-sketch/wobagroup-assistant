import assert from "node:assert/strict";
import test from "node:test";
import { alinearTasaCambioAlMovimientoElegido } from "./alinearTasaAlMovimiento";

/** Caso real (Footprint, 2026-09-28): recibo de Uber de 16.992 COP, cargo elegido "Uber Pending" de -4,57 EUR. */
function escenario(opciones: { total?: string; moneda?: string; tasa?: string; importe?: string; monedaCuenta?: string } = {}) {
  const llamadas: unknown[][] = [];
  const compra: Record<string, unknown> = {
    total: opciones.total ?? "16992,00",
    currency: opciones.moneda ?? "COP",
    currency_change: opciones.tasa ?? "3692.93",
    payments_total: "0,00",
    payments_detail: [] as unknown[],
  };
  const movimiento: Record<string, unknown> = {
    status: "pending",
    reconciled_amount: "0.00",
    currency: opciones.monedaCuenta ?? "EUR",
    amount: opciones.importe ?? "-4.57",
  };
  const elegido = {
    accountId: "a", movementId: "m", fecha: "2026-09-23", descripcion: "Uber Pending",
    monto: Number(opciones.importe ?? "-4.57"), moneda: opciones.monedaCuenta ?? "EUR", origenCoincidencia: "tipo_cambio" as const,
  };
  const deps = {
    leerCompra: async () => compra,
    leerMovimiento: async () => movimiento,
    editar: async (...args: unknown[]) => {
      llamadas.push(args);
      const cambios = args[2] as { tasaCambioNueva: number };
      // Holded devuelve la tasa redondeada a dos decimales.
      return { ...compra, currency_change: cambios.tasaCambioNueva.toFixed(2) };
    },
  };
  return { compra, movimiento, elegido, llamadas, deps: deps as any };
}

test("ajusta la tasa del gasto en COP para que valga exactamente el cargo elegido en EUR", async () => {
  const e = escenario();
  const r = await alinearTasaCambioAlMovimientoElegido("Footprint", "g", e.elegido, e.deps);
  const esperada = Number((16992 / 4.57).toFixed(6));
  assert.equal(r.estado, "ajustada");
  if (r.estado !== "ajustada") return;
  assert.equal(r.tasaNueva, esperada);
  assert.equal(r.tasaAnterior, 3692.93);
  assert.equal(r.montoEur, 4.57);
  assert.equal(e.llamadas.length, 1);
  assert.deepEqual(e.llamadas[0][2], { tasaCambioNueva: esperada });
  assert.match(String((e.llamadas[0][3] as { idempotencyKey: string }).idempotencyKey), /^ajuste-tasa-movimiento:g:m:\d+$/);
  assert.equal((e.llamadas[0][3] as { proceso: string }).proceso, "ajuste_tasa_cambio_movimiento_elegido");
  // El equivalente en EUR del gasto con la tasa nueva coincide con el cargo al céntimo.
  assert.equal(Math.round((16992 / r.tasaNueva) * 100), 457);
});

test("funciona igual para otras monedas (MXN)", async () => {
  const e = escenario({ total: "227,73", moneda: "MXN", tasa: "19.91", importe: "-11.44" });
  const r = await alinearTasaCambioAlMovimientoElegido("Footprint", "g", e.elegido, e.deps);
  assert.equal(r.estado, "ya_alineada"); // 227,73 / 19,91 = 11,44 al céntimo: nada que ajustar
  assert.equal(e.llamadas.length, 0);
  const otro = escenario({ total: "227,73", moneda: "MXN", tasa: "19.91", importe: "-11.30" });
  const ajustada = await alinearTasaCambioAlMovimientoElegido("Footprint", "g", otro.elegido, otro.deps);
  assert.equal(ajustada.estado, "ajustada");
  if (ajustada.estado === "ajustada") assert.equal(Math.round((227.73 / ajustada.tasaNueva) * 100), 1130);
});

test("un reintento con la tasa ya alineada no vuelve a editar", async () => {
  const e = escenario({ tasa: "3718.16" });
  const r = await alinearTasaCambioAlMovimientoElegido("Footprint", "g", e.elegido, e.deps);
  assert.equal(r.estado, "ya_alineada");
  assert.equal(e.llamadas.length, 0);
});

test("no aplica (sin escribir) si el gasto está en EUR, comparte moneda con el cargo o la cuenta no es EUR", async () => {
  for (const [nombre, e] of [
    ["gasto en EUR", escenario({ moneda: "EUR", tasa: "1.00", total: "4,57" })],
    ["misma moneda", escenario({ monedaCuenta: "COP", importe: "-16992.00" })],
    ["cuenta en USD", escenario({ monedaCuenta: "USD" })],
  ] as const) {
    const r = await alinearTasaCambioAlMovimientoElegido("Footprint", "g", e.elegido, e.deps);
    assert.equal(r.estado, "no_aplica", nombre);
    assert.equal(e.llamadas.length, 0, nombre);
  }
});

test("falla cerrado y no escribe: pagos previos, cargo ocupado, cargo cambiado, ingreso o tasa absurda", async () => {
  const casos: Array<[string, (e: ReturnType<typeof escenario>) => void]> = [
    ["pagos previos", (e) => (e.compra.payments_detail as unknown[]).push({ amount: "1" })],
    ["pago total no cero", (e) => { e.compra.payments_total = "5,00"; }],
    ["cargo ocupado", (e) => { e.movimiento.status = "reconciled"; }],
    ["cargo ya con importe conciliado", (e) => { e.movimiento.reconciled_amount = "-4.57"; }],
    ["cargo cambiado", (e) => { e.movimiento.amount = "-4.60"; }],
    ["movimiento de ingreso", (e) => { e.movimiento.amount = "4.57"; }],
    ["tasa implícita lejana", (e) => { e.compra.total = "100000,00"; }],
    ["total inválido", (e) => { e.compra.total = "abc"; }],
  ];
  for (const [nombre, cambiar] of casos) {
    const e = escenario();
    cambiar(e);
    await assert.rejects(alinearTasaCambioAlMovimientoElegido("Footprint", "g", e.elegido, e.deps), /./, nombre);
    assert.equal(e.llamadas.length, 0, nombre);
  }
});

test("si la relectura no confirma la tasa esperada, lanza en vez de dar el ajuste por bueno", async () => {
  const e = escenario();
  e.deps.editar = async (...args: unknown[]) => { e.llamadas.push(args); return { ...e.compra }; }; // Holded no cambió nada
  await assert.rejects(alinearTasaCambioAlMovimientoElegido("Footprint", "g", e.elegido, e.deps), /relectura/);
  const f = escenario();
  f.deps.editar = async (...args: unknown[]) => {
    f.llamadas.push(args);
    return { ...f.compra, currency_change: "3718.16", total: "16000,00" }; // el total nativo cambió
  };
  await assert.rejects(alinearTasaCambioAlMovimientoElegido("Footprint", "g", f.elegido, f.deps), /relectura/);
});

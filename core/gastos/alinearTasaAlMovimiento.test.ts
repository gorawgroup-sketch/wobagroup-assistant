import assert from "node:assert/strict";
import test from "node:test";
import { alinearTasaCambioAlMovimientoElegido } from "./alinearTasaAlMovimiento";

/** Caso real (Footprint, 2026-09-28): recibo de Uber de 16.992 COP, cargo elegido "Uber Pending" de -4,57 EUR. */
function escenario(opciones: { total?: string; moneda?: string; tasa?: string; importe?: string; monedaCuenta?: string } = {}) {
  const llamadas: unknown[][] = [];
  const validaciones: unknown[][] = [];
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
    validar: async (...args: unknown[]) => { validaciones.push(args); return { monedaCompra: "COP", monedaMovimiento: "EUR" }; },
    editar: async (...args: unknown[]) => {
      llamadas.push(args);
      const cambios = args[2] as { tasaCambioNueva: number };
      // Holded devuelve la tasa redondeada a dos decimales.
      return { ...compra, currency_change: cambios.tasaCambioNueva.toFixed(2) };
    },
  };
  return { compra, movimiento, elegido, llamadas, validaciones, deps: deps as any };
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
  assert.match(String((e.llamadas[0][3] as { idempotencyKey: string }).idempotencyKey), /^ajuste-tasa-movimiento:g:m:\d+:[0-9a-f]{12}$/);
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

test("valida por lectura antes de editar: si la conciliación se rechazará, no se toca la tasa", async () => {
  const e = escenario();
  e.deps.validar = async () => { throw new Error("La compra ya tiene pagos o un estado de pagos no verificable."); };
  await assert.rejects(alinearTasaCambioAlMovimientoElegido("Footprint", "g", e.elegido, e.deps), /ya tiene pagos/);
  assert.equal(e.llamadas.length, 0);
  const ok = escenario();
  await alinearTasaCambioAlMovimientoElegido("Footprint", "g", ok.elegido, ok.deps);
  assert.equal(ok.validaciones.length, 1);
});

test("si la tasa a 6 decimales no reproduce el cargo al céntimo (USD grande) no ajusta y lo dice", async () => {
  const e = escenario({ total: "14.051,57", moneda: "USD", tasa: "1.16", importe: "-12095.67" });
  const r = await alinearTasaCambioAlMovimientoElegido("Footprint", "g", e.elegido, e.deps);
  assert.equal(r.estado, "no_aplica");
  if (r.estado === "no_aplica") assert.match(r.motivo, /céntimo/);
  assert.equal(e.llamadas.length, 0);
  assert.equal(e.validaciones.length, 0);
});

test("la clave idempotente cambia si el estado previo del gasto cambió (fecha o número)", async () => {
  const a = escenario();
  await alinearTasaCambioAlMovimientoElegido("Footprint", "g", a.elegido, a.deps);
  const b = escenario();
  b.compra.date = "2026-09-24";
  await alinearTasaCambioAlMovimientoElegido("Footprint", "g", b.elegido, b.deps);
  const claveA = (a.llamadas[0][3] as { idempotencyKey: string }).idempotencyKey;
  const claveB = (b.llamadas[0][3] as { idempotencyKey: string }).idempotencyKey;
  assert.notEqual(claveA, claveB);
});

// Caso real 14-10-2026 (Airbnb México): recibo de 495,13 USD pagado desde la cuenta en USD; Holded contabiliza el cargo por 428,04 €.
test("gasto y cargo en la misma moneda extranjera: la tasa se alinea al equivalente contable del cargo", async () => {
  const e = escenario({ total: "495,13", moneda: "USD", tasa: "1.1000", importe: "-495.13", monedaCuenta: "USD" });
  e.movimiento.accounting_amount = "-428.04";
  e.elegido.origenCoincidencia = "exacta" as never;
  const r = await alinearTasaCambioAlMovimientoElegido("Footprint", "g", e.elegido, e.deps);
  assert.equal(r.estado, "ajustada");
  if (r.estado !== "ajustada") return;
  assert.equal(r.tasaNueva, Number((495.13 / 428.04).toFixed(6)));
  assert.equal(r.montoEur, 428.04);
  assert.equal(e.llamadas.length, 1);
});

test("misma moneda extranjera sin equivalente contable: no se toca nada", async () => {
  const e = escenario({ total: "495,13", moneda: "USD", tasa: "1.1000", importe: "-495.13", monedaCuenta: "USD" });
  const r = await alinearTasaCambioAlMovimientoElegido("Footprint", "g", e.elegido, e.deps);
  assert.equal(r.estado, "no_aplica");
  assert.equal(e.llamadas.length, 0);
});

/** Cargo MAYOR en la misma moneda extranjera (colaborador de Footprint, 2026-10-16): nunca se edita el gasto. */
function escenarioCargoMayor(o: { total: string; tasa: string; cargo: string; contable: string }) {
  const edicion: unknown[][] = [];
  const compra = { total: o.total, currency: "USD", currency_change: o.tasa, payments_total: "0,00", payments_detail: [] as unknown[] };
  const movimiento = { status: "pending", reconciled_amount: "0.00", currency: "USD", amount: `-${o.cargo}`, accounting_amount: `-${o.contable}` };
  const elegido = { accountId: "a", movementId: "m", fecha: "2026-09-11", descripcion: "To Colaborador Monthly Fee", monto: -Number(o.cargo), moneda: "USD", origenCoincidencia: "cargo_mayor" as const };
  const deps = { leerCompra: async () => compra, leerMovimiento: async () => movimiento, validar: async () => ({ monedaCompra: "USD", monedaMovimiento: "USD" }),
    editar: async (...a: unknown[]) => { edicion.push(a); return compra; } };
  return { elegido, edicion, deps: deps as any };
}

test("cargo mayor en USD con diferencia de redondeo (0,04 %): no se edita el gasto y lo explica", async () => {
  const e = escenarioCargoMayor({ total: "1500,00", tasa: "1.16", cargo: "1503.00", contable: "1295.12" });
  const r = await alinearTasaCambioAlMovimientoElegido("Footprint", "g", e.elegido, e.deps);
  assert.equal(r.estado, "no_aplica");
  assert.match((r as { motivo: string }).motivo, /cargo mayor[\s\S]*sin editar el gasto/);
  assert.equal(e.edicion.length, 0, "ningún PUT: cada PUT duplica el adjunto del gasto");
});

test("cargo mayor con la tasa del banco muy distinta (0,49 %): concilia sin editar el gasto y dice que la diferencia queda en el resto", async () => {
  const e = escenarioCargoMayor({ total: "3500,00", tasa: "1.16", cargo: "3528.83", contable: "3056.92" });
  const r = await alinearTasaCambioAlMovimientoElegido("Footprint", "g", e.elegido, e.deps);
  assert.equal(r.estado, "no_aplica");
  assert.match((r as { motivo: string }).motivo, /no se edita el gasto[\s\S]*resto del cargo[\s\S]*gasto bancario/);
  assert.equal(e.edicion.length, 0);
});

test("cargo mayor: un cargo que no es mayor, un gasto con pagos o importes ilegibles se rechazan", async () => {
  const igual = escenarioCargoMayor({ total: "1500,00", tasa: "1.16", cargo: "1500.00", contable: "1293.10" });
  await assert.rejects(() => alinearTasaCambioAlMovimientoElegido("Footprint", "g", igual.elegido, igual.deps), /no es mayor/);
  const conPagos = escenarioCargoMayor({ total: "1500,00", tasa: "1.16", cargo: "1503.00", contable: "1295.12" });
  const deps = { ...conPagos.deps, leerCompra: async () => ({ total: "1500,00", currency: "USD", currency_change: "1.16", payments_total: "10,00", payments_detail: [{ id: "p", amount: "10,00" }] }) };
  await assert.rejects(() => alinearTasaCambioAlMovimientoElegido("Footprint", "g", conPagos.elegido, deps as any), /ya tiene pagos/);
  const sinTasa = escenarioCargoMayor({ total: "1500,00", tasa: "", cargo: "1503.00", contable: "1295.12" });
  await assert.rejects(() => alinearTasaCambioAlMovimientoElegido("Footprint", "g", sinTasa.elegido, sinTasa.deps), /no válidos/);
});

test("sin cargo_mayor un importe distinto en la misma moneda sigue siendo un error (comportamiento anterior)", async () => {
  const e = escenarioCargoMayor({ total: "1500,00", tasa: "1.16", cargo: "1503.00", contable: "1295.12" });
  await assert.rejects(() => alinearTasaCambioAlMovimientoElegido("Footprint", "g", { ...e.elegido, origenCoincidencia: "aproximada" as const }, e.deps), /no coincide con su importe/);
});


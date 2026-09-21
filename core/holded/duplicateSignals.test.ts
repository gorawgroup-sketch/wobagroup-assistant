import assert from "node:assert/strict";
import test from "node:test";
import { esProveedorNoIdentificado, evaluarMovimientoConciliadoComoDuplicado } from "./duplicateSignals";

test("detecta el ticket Hippopotamus ya conciliado como duplicado exacto", () => {
  const resultado = evaluarMovimientoConciliadoComoDuplicado(
    {
      id: "mov-1",
      description: "Hippopotamus",
      amount: "-100.40",
      currency: "EUR",
      booking_date: "2026-09-09T00:00:00+00:00",
      status: "reconciled",
      reconciled_amount: "-100.40",
    },
    { proveedor: "Hippopotamus (Bonneuil)", monto: 100.4, fecha: "2026-09-09", moneda: "EUR" }
  );

  assert.equal(resultado?.nivel, "exacta");
  assert.equal(resultado?.monto, -100.4);
  assert.equal(resultado?.coincideProveedor, true);
});

test("no trata un movimiento pendiente como prueba de gasto ya registrado", () => {
  const resultado = evaluarMovimientoConciliadoComoDuplicado(
    {
      description: "Hippopotamus",
      amount: "-100.40",
      currency: "EUR",
      booking_date: "2026-09-09T00:00:00+00:00",
      status: "pending",
    },
    { proveedor: "Hippopotamus", monto: 100.4, fecha: "2026-09-09", moneda: "EUR" }
  );

  assert.equal(resultado, undefined);
});

test("no bloquea por un monto parecido sin coincidencia suficiente de proveedor y fecha", () => {
  const resultado = evaluarMovimientoConciliadoComoDuplicado(
    {
      description: "Otro comercio",
      amount: "-100.40",
      currency: "EUR",
      booking_date: "2026-08-01T00:00:00+00:00",
      status: "forced_reconciled",
    },
    { proveedor: "Hippopotamus", monto: 100.4, fecha: "2026-09-09", moneda: "EUR" }
  );

  assert.equal(resultado, undefined);
});

test("usa el equivalente contable de una cuenta extranjera al buscar en EUR", () => {
  const resultado = evaluarMovimientoConciliadoComoDuplicado(
    {
      description: "Proveedor global",
      amount: "-108.25",
      currency: "USD",
      accounting_amount: "-100.40",
      booking_date: "2026-09-09T00:00:00+00:00",
      status: "partial",
    },
    { proveedor: "Proveedor Global SL", monto: 100.4, fecha: "2026-09-09", moneda: "EUR" }
  );

  assert.equal(resultado?.nivel, "exacta");
  assert.equal(resultado?.monto, -100.4);
});

test("detecta un ticket sin proveedor contra un cargo exacto y completamente conciliado dos días antes", () => {
  const resultado = evaluarMovimientoConciliadoComoDuplicado(
    {
      id: "mov-gate-gourmet",
      description: "Gate Gourmet Spain Iry",
      amount: "-6.60",
      currency: "EUR",
      booking_date: "2026-09-09T00:00:00+00:00",
      status: "reconciled",
      reconciled_amount: "-6.60",
    },
    { proveedor: "", monto: 6.6, fecha: "2026-09-11", moneda: "EUR" }
  );

  assert.equal(resultado?.nivel, "probable");
  assert.equal(resultado?.diferenciaDias, 2);
  assert.equal(resultado?.sinProveedorIdentificado, true);
});

test("trata las etiquetas descriptivas de proveedor desconocido como ausencia de proveedor real", () => {
  for (const proveedor of [
    "Establecimiento no identificado (cafetería)",
    "Proveedor no identificado en el ticket",
    "Proveedor desconocido",
    "Aerolínea no identificada en el documento",
    "Comercio desconocido en el recibo",
    "Sin proveedor real",
    "Unknown merchant (coffee shop)",
  ]) {
    assert.equal(esProveedorNoIdentificado(proveedor), true, proveedor);
  }
  assert.equal(esProveedorNoIdentificado("Establecimientos Madrid SL"), false);
  assert.equal(esProveedorNoIdentificado("Unknown Pleasures Coffee"), false);
});

test("detecta el cargo conciliado cuando la extracción puso un placeholder de cafetería", () => {
  const resultado = evaluarMovimientoConciliadoComoDuplicado(
    {
      id: "mov-gate-gourmet",
      description: "Gate Gourmet Spain Iry",
      amount: "-6.60",
      currency: "EUR",
      booking_date: "2026-09-09T00:00:00+00:00",
      status: "reconciled",
      reconciled_amount: "-6.60",
    },
    {
      proveedor: "Establecimiento no identificado (cafetería)",
      monto: 6.6,
      fecha: "2026-09-11",
      moneda: "EUR",
    }
  );

  assert.equal(resultado?.nivel, "probable");
  assert.equal(resultado?.sinProveedorIdentificado, true);
  assert.equal(resultado?.diferenciaDias, 2);
});

test("no trata el cargo YA conciliado de un mes anterior como duplicado de una suscripción mensual recurrente", () => {
  // Caso real: Holded Technologies cobra 123.42€/mes a Footprint. El cargo
  // de julio y el de agosto ya estaban conciliados contra sus propias
  // facturas de esos meses — no deben bloquear la factura NUEVA de
  // septiembre solo por compartir proveedor e importe exacto.
  const criterios = { proveedor: "Holded Technologies", monto: 123.42, fecha: "2026-09-09", moneda: "EUR" };

  const cargoJulio = evaluarMovimientoConciliadoComoDuplicado(
    {
      id: "mov-julio",
      description: "Main Holded Technologies Sl",
      amount: "-123.42",
      currency: "EUR",
      booking_date: "2026-07-09T00:00:00+00:00",
      status: "reconciled",
      reconciled_amount: "-123.42",
    },
    criterios
  );
  const cargoAgosto = evaluarMovimientoConciliadoComoDuplicado(
    {
      id: "mov-agosto",
      description: "Main Holded Technologies Sl",
      amount: "-123.42",
      currency: "EUR",
      booking_date: "2026-08-09T00:00:00+00:00",
      status: "reconciled",
      reconciled_amount: "-123.42",
    },
    criterios
  );

  assert.equal(cargoJulio, undefined);
  assert.equal(cargoAgosto, undefined);
});

test("sí detecta el cargo del mismo proveedor cuando la fecha está razonablemente cerca", () => {
  const resultado = evaluarMovimientoConciliadoComoDuplicado(
    {
      id: "mov-septiembre",
      description: "Main Holded Technologies Sl",
      amount: "-123.42",
      currency: "EUR",
      booking_date: "2026-09-12T00:00:00+00:00",
      status: "reconciled",
      reconciled_amount: "-123.42",
    },
    { proveedor: "Holded Technologies", monto: 123.42, fecha: "2026-09-09", moneda: "EUR" }
  );

  assert.equal(resultado?.nivel, "probable");
  assert.equal(resultado?.diferenciaDias, 3);
});

test("caso real Carlos (Footprint, 2026-09-08): dos viajes de Uber distintos el mismo día no se confunden entre sí solo por compartir proveedor y fecha", () => {
  // El movimiento real "Uber Pending" de 3.55 USD, ya conciliado, no debe bloquear un ticket
  // DISTINTO de 3.77 USD del mismo proveedor y fecha — son dos viajes reales distintos, no la
  // misma transacción con una pequeña variación de redondeo.
  const resultado = evaluarMovimientoConciliadoComoDuplicado(
    {
      id: "mov-uber-355",
      description: "Uber Pending",
      amount: "-3.55",
      currency: "USD",
      booking_date: "2026-09-08T00:00:00+00:00",
      status: "reconciled",
      reconciled_amount: "-3.55",
    },
    { proveedor: "Uber", monto: 3.77, fecha: "2026-09-08", moneda: "USD" }
  );

  assert.equal(resultado, undefined);
});

test("sin proveedor no bloquea por fecha lejana, conciliación parcial o importe aproximado", () => {
  const criterios = { proveedor: "", monto: 6.6, fecha: "2026-09-11", moneda: "EUR" };
  const base = {
    description: "Comercio sin identificar",
    amount: "-6.60",
    currency: "EUR",
    booking_date: "2026-09-09T00:00:00+00:00",
    status: "reconciled",
    reconciled_amount: "-6.60",
  };

  assert.equal(evaluarMovimientoConciliadoComoDuplicado({ ...base, booking_date: "2026-09-01T00:00:00+00:00" }, criterios), undefined);
  assert.equal(evaluarMovimientoConciliadoComoDuplicado({ ...base, status: "partial", reconciled_amount: "-3.30" }, criterios), undefined);
  assert.equal(evaluarMovimientoConciliadoComoDuplicado({ ...base, amount: "-6.55", reconciled_amount: "-6.55" }, criterios), undefined);
});

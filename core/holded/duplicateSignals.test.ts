import assert from "node:assert/strict";
import test from "node:test";
import { evaluarMovimientoConciliadoComoDuplicado } from "./duplicateSignals";

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

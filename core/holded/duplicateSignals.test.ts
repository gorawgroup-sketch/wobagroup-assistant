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

import { esCargoLibreExactoParaDuplicado, priorizarCargoLibreExacto } from "./duplicateSignals";
test("Uber 9.89 libre exacto prevalece sobre 9.83 conciliado probable, no sobre uno exacto", () => {
  const c={proveedor:"Uber",monto:9.89,moneda:"EUR",fecha:"2026-09-07"};
  const libre={id:"libre",origin:"bankin",description:"Dlo Uberrides",amount:"-9.89",currency:"EUR",booking_date:"2026-09-07",status:"pending",reconciled_amount:"0.00"};
  assert.equal(esCargoLibreExactoParaDuplicado(libre,c),true);
  const probable={nivel:"probable" as const,monto:9.83,moneda:"EUR"};
  const exacto={nivel:"exacta" as const,monto:9.89,moneda:"EUR"};
  assert.deepEqual(priorizarCargoLibreExacto([probable,exacto],new Set(["cuenta/libre"]),9.89,"EUR"),[exacto]);
  for(const cambio of [{amount:"9.89"},{currency:"USD"},{status:"partial"},{reconciled_amount:"0.01"},{origin:"manual"},{booking_date:"2026-09-08"},{description:"Otro comercio"}]) {
    assert.equal(esCargoLibreExactoParaDuplicado({...libre,...cambio},c),false);
  }
  assert.deepEqual(priorizarCargoLibreExacto([probable],new Set(),9.89),[probable]);
  assert.deepEqual(priorizarCargoLibreExacto([probable],new Set(["a/1","b/2"]),9.89),[probable]);
  const mismoImporte={...probable,monto:9.89};
  assert.deepEqual(priorizarCargoLibreExacto([mismoImporte],new Set(["a/1"]),9.89),[mismoImporte]);
});

test("un cargo libre único del recibo distingue otro cargo antiguo por el mismo importe", () => {
  const criterios = { proveedor: "Uber", monto: 4.25, moneda: "EUR", fecha: "2026-06-23" };
  const libre = { id: "nuevo", origin: "bankin", description: "Uber Pending", amount: "-4.25", currency: "EUR", booking_date: criterios.fecha, status: "pending", reconciled_amount: "0" };
  assert.equal(esCargoLibreExactoParaDuplicado(libre, criterios), true);
  for (const monto of [4.24, 4.25]) {
    const antiguo = { nivel: "probable" as const, monto, moneda: "EUR", fecha: "2026-06-08" };
    const aplicar = (items: typeof antiguo[], ids = new Set(["cuenta/nuevo"])) => priorizarCargoLibreExacto(items, ids, criterios.monto, criterios.moneda, criterios.fecha);
    assert.deepEqual(aplicar([antiguo]), []);
    assert.deepEqual(aplicar([antiguo], new Set()), [antiguo]);
    assert.deepEqual(aplicar([antiguo], new Set(["a", "b"])), [antiguo]);
    for (const fecha of [criterios.fecha, "2026-06-22", "2026-06-20", "invalida"]) {
      const ambiguo = { ...antiguo, fecha };
      // Mismo importe al céntimo: sigue ambiguo en 3 días. Un céntimo de diferencia: solo ambiguo si cae el mismo día del recibo
      // (o si la fecha no se puede comparar). Decisión de Carlos, 2026-10-04: importe y día distintos = otro viaje.
      const sigueAmbiguo = monto === 4.25 || fecha === criterios.fecha || fecha === "invalida";
      assert.deepEqual(aplicar([ambiguo]), sigueAmbiguo ? [ambiguo] : []);
    }
    const exacto = { ...antiguo, nivel: "exacta" as const };
    assert.deepEqual(priorizarCargoLibreExacto([exacto], new Set(["a"]), 4.25, "EUR", criterios.fecha), [exacto]);
  }
});

test("caso Uber 5,95 USD: el cargo libre exacto del 02/10 gana al conciliado 5,96 del 29/09 (importe y día distintos)", () => {
  const criterios = { proveedor: "Uber", monto: 5.95, moneda: "USD", fecha: "2026-10-02" };
  const libre = { id: "6ac1161152090c3def0044c7", origin: "bankin", description: "Uber Pending", amount: "-5.95", currency: "USD", booking_date: "2026-10-02", status: "pending", reconciled_amount: "0.00" };
  assert.equal(esCargoLibreExactoParaDuplicado(libre, criterios), true);
  const aplicar = (items: Array<{ nivel: "probable" | "exacta"; monto: number; moneda: string; fecha: string }>) =>
    priorizarCargoLibreExacto(items, new Set(["ftg/libre"]), criterios.monto, criterios.moneda, criterios.fecha);
  const deOtroViaje = { nivel: "probable" as const, monto: 5.96, moneda: "USD", fecha: "2026-09-29" };
  assert.deepEqual(aplicar([deOtroViaje]), []);
  // Sigue bloqueando: mismo importe al céntimo, o el mismo día del recibo con un céntimo de diferencia.
  const mismoImporte = { ...deOtroViaje, monto: 5.95 };
  const mismoDia = { ...deOtroViaje, fecha: "2026-10-02" };
  assert.deepEqual(aplicar([mismoImporte]), [mismoImporte]);
  assert.deepEqual(aplicar([mismoDia]), [mismoDia]);
  // Sin cargo libre único, no se descarta nada.
  assert.deepEqual(priorizarCargoLibreExacto([deOtroViaje], new Set(), 5.95, "USD", "2026-10-02"), [deOtroViaje]);
});

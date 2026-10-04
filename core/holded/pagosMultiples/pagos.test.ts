import assert from "node:assert/strict";
import test from "node:test";
import { emparejarPagos, esAnteriorAlGasto, evaluarPagosMultiples, normalizarPagos, pagosCuadran, type MovimientoBanco } from "./pagos";

const mov = (id: string, fecha: string, monto: number, descripcion = "Uber Pending"): MovimientoBanco => ({ accountId: "cta", cuenta: "FTG USD", movementId: id, fecha, monto, moneda: "USD", descripcion });
// Caso real (Footprint, 28/09/2026): recibo Uber 8,95 USD cobrado como 6,91 + 2,04; en el banco también hay un cargo parecido de 9,95 del 25/09.
const PAGOS = [{ monto: 6.91, fecha: "2026-09-28" }, { monto: 2.04, fecha: "2026-09-28" }];
const BANCO = [mov("a", "2026-09-28", 6.91), mov("b", "2026-09-28", 2.04), mov("viejo", "2026-09-25", 9.95), mov("otro", "2026-09-28", 12.5, "Netflix")];

test("lee los pagos del recibo: importes positivos y fechas válidas; ignora basura", () => {
  assert.deepEqual(normalizarPagos([{ monto: 6.911, fecha: "2026-09-28" }, { monto: "2.04" }, { monto: -3 }, { monto: "x" }, null]), [{ monto: 6.91, fecha: "2026-09-28" }, { monto: 2.04, fecha: undefined }]);
  assert.deepEqual(normalizarPagos(undefined), []);
});

test("los pagos solo valen si suman el total del recibo y son al menos dos", () => {
  assert.equal(pagosCuadran(PAGOS, 8.95), true);
  assert.equal(pagosCuadran(PAGOS, 9.95), false);
  assert.equal(pagosCuadran([{ monto: 8.95 }], 8.95), false);
});

test("un movimiento anterior al gasto no puede ser su cargo (1 día de holgura)", () => {
  assert.equal(esAnteriorAlGasto("2026-09-25", "2026-09-28"), true);
  assert.equal(esAnteriorAlGasto("2026-09-27", "2026-09-28"), false);
  assert.equal(esAnteriorAlGasto("2026-09-28", "2026-09-28"), false);
});

test("empareja cada pago con SU movimiento (6,91 y 2,04 del 28/09) y nunca con el cargo anterior de 9,95", () => {
  const r = emparejarPagos(PAGOS, BANCO, "2026-09-28");
  assert.deepEqual(r.pares.map((p) => p.movimiento.movementId).sort(), ["a", "b"]);
  assert.equal(r.sinPareja.length, 0);
});

test("un movimiento no se usa dos veces y un pago sin movimiento queda sin pareja", () => {
  const r = emparejarPagos([{ monto: 2.04 }, { monto: 2.04 }], BANCO, "2026-09-28");
  assert.equal(r.pares.length, 1); assert.equal(r.sinPareja.length, 1);
  const parcial = emparejarPagos(PAGOS, [mov("a", "2026-09-28", 6.91)], "2026-09-28");
  assert.deepEqual(parcial.sinPareja, [{ monto: 2.04, fecha: "2026-09-28" }]);
});

test("el caso del Uber: propone los DOS cargos reales y descarta la coincidencia aproximada anterior al gasto", async () => {
  const r = await evaluarPagosMultiples({ empresa: "Footprint", moneda: "USD", total: 8.95, fechaGasto: "2026-09-28", pagos: PAGOS,
    aproximada: { fecha: "2026-09-25", monto: 9.95, descripcion: "Uber Pending" } }, async () => BANCO);
  assert.equal(r.descartarAproximado, true);
  assert.match(r.nota, /2 pagos \(6\.91 \+ 2\.04 = 8\.95 USD\)/);
  assert.match(r.nota, /6\.91 USD \(2026-09-28\)/); assert.match(r.nota, /2\.04 USD \(2026-09-28\)/);
  assert.match(r.nota, /ANTERIOR al gasto/);
  assert.match(r.nota, /aún no está activado/);
});

test("sin pagos múltiples solo actúa la guardia de fecha: una aproximada anterior se descarta; una de la misma fecha, no", async () => {
  const anterior = await evaluarPagosMultiples({ empresa: "Footprint", moneda: "USD", total: 8.95, fechaGasto: "2026-09-28", aproximada: { fecha: "2026-09-25", monto: 9.95 } });
  assert.equal(anterior.descartarAproximado, true);
  const normal = await evaluarPagosMultiples({ empresa: "Footprint", moneda: "USD", total: 8.95, fechaGasto: "2026-09-28", aproximada: { fecha: "2026-09-28", monto: 8.9 } });
  assert.equal(normal.descartarAproximado, false); assert.equal(normal.nota, "");
});

test("si el banco no responde, no se propone nada aproximado y se dice", async () => {
  const r = await evaluarPagosMultiples({ empresa: "Footprint", moneda: "USD", total: 8.95, fechaGasto: "2026-09-28", pagos: PAGOS }, async () => { throw new Error("503"); });
  assert.equal(r.descartarAproximado, true); assert.match(r.nota, /No pude consultar el banco/);
});

test("pago que falta en el banco: se informa y no se propone ninguna aproximada", async () => {
  const r = await evaluarPagosMultiples({ empresa: "Footprint", moneda: "USD", total: 8.95, fechaGasto: "2026-09-28", pagos: PAGOS }, async () => [mov("a", "2026-09-28", 6.91)]);
  assert.equal(r.descartarAproximado, true); assert.match(r.nota, /No encontré en el banco el\/los pago\(s\) de 2\.04 USD/);
});

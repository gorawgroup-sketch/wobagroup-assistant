import assert from "node:assert/strict";
import test from "node:test";
import { aplicarConfirmacionAPagos, sumarMeses } from "./confirmacion";
import { pago } from "./pruebas";

test("sumar meses respeta el fin de mes y cruza de año", () => {
  assert.equal(sumarMeses("2027-02-27", 6), "2027-08-27");
  assert.equal(sumarMeses("2027-08-31", 6), "2028-02-29", "2028 es bisiesto");
  assert.equal(sumarMeses("2026-08-31", 6), "2027-02-28");
  assert.equal(sumarMeses("2027-04-17", 12), "2028-04-17");
  assert.equal(sumarMeses("2027-11-15", 3), "2028-02-15");
});

const adeudo = { polizaIds: ["woba_rc_markel"], fecha: "2027-04-19", importe: 2050.1, movimientoId: "mov1", cuenta: "BBVA" };
const renovacion = pago({ id: "woba_rc_markel:2027-04-17", polizaId: "woba_rc_markel", fecha: "2027-04-17", importe: 2012.65, recurrenciaMeses: 12, concepto: "RC Markel — renovación" });

test("un adeudo confirmado marca el pago como pagado con el importe REAL y genera el siguiente de la serie (estimado, sin evento ni avisos)", () => {
  const r = aplicarConfirmacionAPagos([renovacion], adeudo, "2027-04-20");
  assert.equal(r.actualizaciones.length, 1);
  assert.equal(r.actualizaciones[0].id, "woba_rc_markel:2027-04-17");
  assert.equal(r.actualizaciones[0].cambios.estado, "pagado");
  assert.equal(r.actualizaciones[0].cambios.importe, 2050.1);
  assert.equal(r.actualizaciones[0].cambios.estimado, false);
  assert.match(String(r.actualizaciones[0].cambios.notas), /Pagado 19\/04\/2027: 2\.050,10 € en BBVA \(apunte mov1\)/);
  assert.equal(r.nuevos.length, 1);
  assert.equal(r.nuevos[0].id, "woba_rc_markel:2028-04-17");
  assert.equal(r.nuevos[0].fecha, "2028-04-17");
  assert.equal(r.nuevos[0].importe, 2050.1, "el siguiente parte del último importe real");
  assert.equal(r.nuevos[0].estimado, true);
  assert.equal(r.nuevos[0].estado, "previsto");
  assert.equal(r.nuevos[0].eventoCalendarId, "");
  assert.equal(r.nuevos[0].avisos, "");
});

test("no genera un siguiente si la serie ya lo tiene (a menos de 20 días de esa fecha) ni si el pago no es recurrente", () => {
  const yaExiste = pago({ id: "woba_rc_markel:2028-04-20", polizaId: "woba_rc_markel", fecha: "2028-04-20" });
  assert.equal(aplicarConfirmacionAPagos([renovacion, yaExiste], adeudo, "2027-04-20").nuevos.length, 0);
  const unico = pago({ ...renovacion, recurrenciaMeses: 0 });
  const r = aplicarConfirmacionAPagos([unico], adeudo, "2027-04-20");
  assert.equal(r.actualizaciones.length, 1);
  assert.equal(r.nuevos.length, 0);
});

test("solo casa con el pago previsto de esa póliza dentro del margen de fecha y con un importe parecido", () => {
  assert.equal(aplicarConfirmacionAPagos([renovacion], { ...adeudo, fecha: "2027-06-01" }, "x").actualizaciones.length, 0, "a más de 12 días");
  assert.equal(aplicarConfirmacionAPagos([renovacion], { ...adeudo, importe: 323.24 }, "x").actualizaciones.length, 0, "el recibo suelto de un suplemento no es la renovación");
  assert.equal(aplicarConfirmacionAPagos([renovacion], { ...adeudo, polizaIds: ["otra"] }, "x").actualizaciones.length, 0);
  assert.equal(aplicarConfirmacionAPagos([pago({ ...renovacion, estado: "pagado" })], adeudo, "x").actualizaciones.length, 0, "uno ya pagado no se vuelve a pagar");
  assert.equal(aplicarConfirmacionAPagos([renovacion], { ...adeudo, importe: 2100 }, "x").actualizaciones.length, 1, "dentro del 15 %");
});

test("entre dos candidatos elige el de la fecha más cercana", () => {
  const cerca = pago({ id: "p:2027-04-17", polizaId: "p", fecha: "2027-04-17", importe: 100, recurrenciaMeses: 0 });
  const lejos = pago({ id: "p:2027-04-28", polizaId: "p", fecha: "2027-04-28", importe: 100, recurrenciaMeses: 0 });
  const r = aplicarConfirmacionAPagos([lejos, cerca], { polizaIds: ["p"], fecha: "2027-04-18", importe: 100, movimientoId: "m", cuenta: "BBVA" }, "x");
  assert.deepEqual(r.actualizaciones.map((a) => a.id), ["p:2027-04-17"]);
});

test("una transferencia que paga varios recibos (como los 1.306,00 € de Acodrid) marca cada pago de su póliza sin exigir que el total cuadre con uno", () => {
  const cuota = pago({ id: "allianz:2027-03-01", polizaId: "allianz", fecha: "2027-03-01", importe: 955 });
  const complemento = pago({ id: "compl:2027-03-01", polizaId: "compl", fecha: "2027-03-01", importe: 289.14 });
  const r = aplicarConfirmacionAPagos([cuota, complemento], { polizaIds: ["allianz", "compl"], fecha: "2027-03-02", importe: 1244.14, movimientoId: "t", cuenta: "BBVA" }, "x");
  assert.deepEqual(r.actualizaciones.map((a) => a.id).sort(), ["allianz:2027-03-01", "compl:2027-03-01"]);
  for (const a of r.actualizaciones) {
    assert.equal(a.cambios.importe, a.id.startsWith("allianz") ? 955 : 289.14, "con varios recibos no se reparte el total: se conserva el de cada fila");
    assert.equal(a.cambios.estimado, true, "y sigue siendo estimado hasta ver cada recibo");
  }
  assert.equal(r.nuevos.length, 2);
  assert.deepEqual(r.nuevos.map((n) => n.fecha), ["2027-09-01", "2027-09-01"]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { eventoDePago, fechaDelEvento, instanteMadrid } from "./eventoCalendario";
import { pago } from "./pruebas";

test("las 9:00 de Madrid son las 8:00 UTC en invierno y las 7:00 UTC en verano, también el día del cambio de hora", () => {
  assert.equal(instanteMadrid("2027-02-24"), "2027-02-24T08:00:00.000Z");
  assert.equal(instanteMadrid("2027-07-01"), "2027-07-01T07:00:00.000Z");
  assert.equal(instanteMadrid("2027-03-27"), "2027-03-27T08:00:00.000Z", "el día antes del cambio (CET)");
  assert.equal(instanteMadrid("2027-03-28"), "2027-03-28T07:00:00.000Z", "el día del cambio, a las 9:00 ya es CEST");
  assert.equal(instanteMadrid("2027-10-31"), "2027-10-31T08:00:00.000Z", "el día que vuelve al horario de invierno, a las 9:00 ya es CET");
  assert.equal(instanteMadrid("2027-02-24", "17:30"), "2027-02-24T16:30:00.000Z");
});

test("el evento va tres días antes del pago, a las 9:00, con el importe (estimado), la cuenta y lo que hará Wobi", () => {
  const p = pago({ fecha: "2027-03-01", importe: 955, notas: "Importe por confirmar con Acodrid." });
  assert.equal(fechaDelEvento(p), "2027-02-26");
  const e = eventoDePago(p);
  assert.equal(e.fechaHoraInicioISO, "2027-02-26T08:00:00.000Z");
  assert.equal(e.duracionMinutos, 30);
  assert.equal(e.resumen, "🛡️ Seguro: Allianz showroom 054239034 — 2.ª cuota semestral 2026/27 — 955,00 € (estimado) el 01/03/2027");
  assert.match(e.descripcion, /Pago de seguro en 3 días \(01\/03\/2027\)/);
  assert.match(e.descripcion, /Cuenta de cargo: BBVA \(adeudo\)/);
  assert.match(e.descripcion, /avisará por Telegram con la comprobación de saldo/);
  assert.match(e.descripcion, /Importe por confirmar con Acodrid\./);
});

test("un importe confirmado no dice «estimado»", () => {
  assert.doesNotMatch(eventoDePago(pago({ estimado: false })).resumen, /estimado/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { esHospedaje, esMismaEstancia, fechasDeEstancia } from "./mismaEstancia";

const factura50808 = { concepto: "Hospedaje Hotel101 Madrid — Simon Talloen — 09-11 sep 2026 (2 noches, Standard Double Room) + cargo carga vehículo eléctrico", monto: 242.19, moneda: "EUR" };
const recibo = { concepto: "Hospedaje Hotel101 Madrid — Simon Talloen — 09-11 sep 2026 (2 noches, reserva 6188872919)", monto: 232.2, moneda: "EUR" };
const factura50809 = { concepto: "Hospedaje Hotel101 Madrid — Simon Talloen — 06-07 sep 2026 (1 noche, Standard Double Room)", monto: 66.61, moneda: "EUR" };
const factura50810 = { concepto: "Hospedaje Hotel101 Madrid — Simon Talloen — 07–09 sep 2026 (2 noches, Standard Double Room)", monto: 174.59, moneda: "EUR" };
const pulse95 = { concepto: "Hospedaje Pulse 95 by Wynwood House — Bogotá, Colombia — Simon Talloen — 2 noches (21-23 sep 2026), Studio Apartment (419420 COP, comprobante en COP)", monto: 133.37, moneda: "USD" };
const guadalajara = { concepto: "Hospedaje Hotel Plaza Diana — Guadalajara, México — Jorge Jácome — 24–27 ago 2026 (3 noches)", monto: 204.65, moneda: "EUR" };

test("caso real: el recibo de Booking y la factura del hotel de la misma estancia (232,20 € vs 242,19 €)", () => {
  assert.equal(esMismaEstancia(recibo, factura50808), true);
  assert.equal(esMismaEstancia(factura50808, recibo), true);
});

test("estancias distintas del mismo huésped y hotel no coinciden (fechas distintas)", () => {
  assert.equal(esMismaEstancia(recibo, factura50809), false);
  assert.equal(esMismaEstancia(recibo, factura50810), false);
  assert.equal(esMismaEstancia(factura50809, factura50810), false);
});

test("otro hotel, otra persona o otra moneda no coinciden", () => {
  assert.equal(esMismaEstancia(pulse95, factura50808), false);
  assert.equal(esMismaEstancia(guadalajara, recibo), false);
  assert.equal(esMismaEstancia({ ...recibo, concepto: recibo.concepto.replace("Simon Talloen", "Jorge Jácome") }, factura50808), false);
  assert.equal(esMismaEstancia({ ...recibo, moneda: "USD" }, factura50808), false);
});

test("un importe muy distinto no coincide (más de 8 %)", () => {
  assert.equal(esMismaEstancia({ ...recibo, monto: 150 }, factura50808), false);
});

test("con ciudad en un concepto y no en el otro sigue coincidiendo", () => {
  const conCiudad = { concepto: "Hospedaje Hotel101 Madrid — Madrid, España — Simon Talloen — 09-11 sep 2026 (2 noches)", monto: 232.2, moneda: "EUR" };
  assert.equal(esMismaEstancia(conCiudad, factura50808), true);
});

test("no es hospedaje o falta información: no coincide", () => {
  assert.equal(esMismaEstancia({ concepto: "Tiquete aéreo LATAM — Simon Talloen — 24 sep 2026", monto: 278.02, moneda: "EUR" }, factura50808), false);
  assert.equal(esMismaEstancia({ monto: 232.2, moneda: "EUR" }, factura50808), false);
});

test("lee varios formatos de fechas", () => {
  assert.deepEqual(fechasDeEstancia("— 09-11 sep 2026 (2 noches)"), { desde: { dia: 9, mes: 9 }, hasta: { dia: 11, mes: 9 } });
  assert.deepEqual(fechasDeEstancia("— 07–09 sep 2026"), { desde: { dia: 7, mes: 9 }, hasta: { dia: 9, mes: 9 } });
  assert.deepEqual(fechasDeEstancia("21 al 23 de septiembre"), { desde: { dia: 21, mes: 9 }, hasta: { dia: 23, mes: 9 } });
  assert.deepEqual(fechasDeEstancia("30 sep - 02 oct 2026"), { desde: { dia: 30, mes: 9 }, hasta: { dia: 2, mes: 10 } });
  assert.equal(fechasDeEstancia("sin fechas"), undefined);
});

test("solo los conceptos de hospedaje activan la comprobación (el resto de gastos no paga lecturas)", () => {
  assert.equal(esHospedaje("Hospedaje Hotel101 Madrid — Simon Talloen — 09-11 sep 2026"), true);
  assert.equal(esHospedaje("Alojamiento en Lisboa"), true);
  assert.equal(esHospedaje("Gastos de comunidad y garaje — Edificio Luarca"), false);
  assert.equal(esHospedaje("Traslado Uber (UberX)"), false);
});

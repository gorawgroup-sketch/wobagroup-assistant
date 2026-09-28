import assert from "node:assert/strict";
import test from "node:test";
import { movimientoCompatibleConGasto } from "./write";

/**
 * Corpus de CASOS REALES de «¿este descriptor bancario puede ser este proveedor?». Cada vez que un caso real falle en
 * producción se añade aquí una fila con el par exacto que falló (y la decisión correcta): así una corrección no se
 * puede deshacer sin que falle una prueba, y el sistema no repite el mismo error con otro nombre. Los pares proceden de
 * Holded (Footprint, septiembre 2026).
 */
const CONCEPTO_UBER = "Traslado Uber (Priority) — Cra. 22 #63-23 → Cra. 11 #93-80, Bogotá, Colombia";

const compatibles: Array<[string, string, string, string]> = [
  ["Uber Colombia: descriptores del banco", "UBER COLOMBIA", CONCEPTO_UBER, "Uber Pending"],
  ["Uber Colombia: adquirente Dl", "UBER COLOMBIA", CONCEPTO_UBER, "Dl *uberrides"],
  ["Uber Colombia: adquirente Payu", "UBER COLOMBIA", CONCEPTO_UBER, "Payu*uber"],
  ["Uber Colombia: trip", "UBER COLOMBIA", CONCEPTO_UBER, "Uber *trip Help.uber.c"],
  ["Uber Colombia: rides", "UBER COLOMBIA", CONCEPTO_UBER, "Uber*rides"],
  ["Uber Colombia: servicio", "UBER COLOMBIA", CONCEPTO_UBER, "Dlo*serv Uber Rides Ca"],
  ["La Última Cena (Clover): mismo nombre", "LA ULTIMA CENA", "Cena restaurante — Luquillo, Puerto Rico", "La Ultima Cena"],
  ["2026-09-28: el ticket dice PLM y el banco Luxury", "JUST B CUZ PLM", "Café — JUST B CUZ PLM, San Juan, Puerto Rico — Simon Talloen", "Par*just B Cuz Luxury"],
];

const incompatibles: Array<[string, string, string, string]> = [
  ["Uber Eats no es un viaje de Uber", "Uber Eats", "Comida a domicilio", "Uber Pending"],
  ["un taxi no es un restaurante aunque el importe coincida", "Bolt", "Taxi aeropuerto", "Osteria Del Lovo"],
];

for (const [nombre, proveedor, concepto, descriptor] of compatibles) {
  test(`compatible — ${nombre}`, () => assert.equal(movimientoCompatibleConGasto(proveedor, concepto, descriptor), true));
}
for (const [nombre, proveedor, concepto, descriptor] of incompatibles) {
  test(`incompatible — ${nombre}`, () => assert.equal(movimientoCompatibleConGasto(proveedor, concepto, descriptor), false));
}

import assert from "node:assert/strict";
import test from "node:test";
import { calcularSenalDeViaje } from "./write";

// Caso real GoToWebinar (Carlos, Footprint, 2026-09-29): una suscripción mensual de software (factura
// FORMAL a nombre de la empresa, proveedor extranjero) terminó clasificada en "Gastos de viaje" porque
// reciboSimplificado se activa también para cualquier factura formal de un proveedor fuera de España
// (ver su docstring en extractInvoiceData.ts, necesario ahí para el tratamiento de IVA por inversión del
// sujeto pasivo) y ticketDeEquipo es true para casi cualquier correo automático del propio grupo —
// ninguna de las dos distingue una suscripción de un ticket informal individual.
test("caso real GoToWebinar: una suscripción nunca activa el tier de viaje aunque lleguen las dos señales overloaded", () => {
  const criterios = { ticketDeEquipo: true, reciboSimplificado: true };
  assert.equal(calcularSenalDeViaje(criterios, ["suscripcion"]), false);
});

test("caso real D1 SAS (sin persona identificada): el atajo heurístico sigue funcionando cuando NO es una suscripción", () => {
  const criterios = { ticketDeEquipo: true, reciboSimplificado: true };
  assert.equal(calcularSenalDeViaje(criterios, []), true);
  assert.equal(calcularSenalDeViaje(criterios, ["alimentacion"]), true);
});

test("una persona identificada con recibo simplificado sigue activando viaje si no es una suscripción", () => {
  const criterios = { personaAsociada: "Simon Talloen", reciboSimplificado: true };
  assert.equal(calcularSenalDeViaje(criterios, ["alimentacion"]), true);
  assert.equal(calcularSenalDeViaje(criterios, ["suscripcion"]), false);
});

test("contextoDeViaje detectado directamente por la IA se respeta sin condición, incluso si tagsCategoria dice suscripcion", () => {
  // La IA ya excluye suscripciones en su propio prompt (ver contexto_de_viaje en extractInvoiceData.ts);
  // si aun así lo reporta true, es su juicio directo sobre el documento, más confiable que el atajo.
  assert.equal(calcularSenalDeViaje({ contextoDeViaje: true }, ["suscripcion"]), true);
});

test("sin ninguna señal, no hay contexto de viaje", () => {
  assert.equal(calcularSenalDeViaje({}, []), false);
  assert.equal(calcularSenalDeViaje({ reciboSimplificado: true }, []), false);
  assert.equal(calcularSenalDeViaje({ ticketDeEquipo: true }, []), false);
});

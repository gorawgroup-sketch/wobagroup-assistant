import assert from "node:assert/strict";
import test from "node:test";
import { puntuarContactoParecido } from "./write";

test("caso real Carlos (Footprint, Uber Costa Rica, 2026-09-16): el contexto del gasto desempata entre variantes por país de la misma marca", () => {
  const concepto = "Viaje Uber — Ricoh CR a Aeropuerto CR — San José, Costa Rica — Nicolás Gómez — viaje Centroamérica";
  const colombia = puntuarContactoParecido("Uber", "UBER COLOMBIA", concepto);
  const panama = puntuarContactoParecido("Uber", "UBER PANAMA", concepto);
  const costaRica = puntuarContactoParecido("Uber", "UBER COSTA RICA", concepto);

  assert.ok(costaRica > colombia, `Costa Rica (${costaRica}) debería superar a Colombia (${colombia})`);
  assert.ok(costaRica > panama, `Costa Rica (${costaRica}) debería superar a Panamá (${panama})`);
});

test("sin pista contextual, las variantes por país de una misma marca siguen empatando (comportamiento previo intacto)", () => {
  const colombia = puntuarContactoParecido("Uber", "UBER COLOMBIA");
  const panama = puntuarContactoParecido("Uber", "UBER PANAMA");
  const costaRica = puntuarContactoParecido("Uber", "UBER COSTA RICA");
  assert.equal(colombia, panama);
  assert.equal(panama, costaRica);
});

test("el bonus de contexto nunca hace aparecer un contacto que no coincide por nombre real", () => {
  const score = puntuarContactoParecido("Uber", "HOTEL COLUMBUS", "Costa Rica San José");
  assert.equal(score, 0);
});

test("un contexto que no menciona ningún país no altera el desempate entre variantes", () => {
  const colombia = puntuarContactoParecido("Uber", "UBER COLOMBIA", "Viaje de negocios, sin más detalle");
  const panama = puntuarContactoParecido("Uber", "UBER PANAMA", "Viaje de negocios, sin más detalle");
  assert.equal(colombia, panama);
});

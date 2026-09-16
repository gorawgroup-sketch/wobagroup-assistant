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

test("caso real HEMA/\"Van de Valk Hotel Venio\" (Footprint, 2026-09-16): un nombre de calle largo no gana por compartir solo el prefijo con un contacto sin relación", () => {
  const concepto =
    "Compra HEMA Breda — 2x mok strak 350ml, fashion sokken, herensokken, 3-pak boxershort, 3-pak regular boxer (gasto personal Simon Talloen)";
  const nombre = "HEMA (Breda - Valkeniersplein)";
  // "valkeniersplein" (nombre de la calle, 15 letras) comparte solo el prefijo "valk" (4 letras) con
  // "VAN DE VALK HOTEL VENIO" — una coincidencia demasiado corta respecto al largo real de la palabra
  // para contar como la misma palabra; no debe puntuar nada.
  const vanDeValk = puntuarContactoParecido(nombre, "VAN DE VALK HOTEL VENIO", concepto);
  const hema = puntuarContactoParecido(nombre, "HEMA", concepto);
  assert.equal(vanDeValk, 0);
  assert.ok(hema > vanDeValk, `HEMA (${hema}) debería superar a Van de Valk Hotel Venio (${vanDeValk})`);
});

test("el prefijo compartido sigue contando entre palabras de largo parecido (plural/singular, typos de OCR)", () => {
  assert.equal(puntuarContactoParecido("Ocean Facility", "OCEAN FACILITY SERVICES SA.") > 0, true);
  // Caso real Hotel101 (Footprint, "management"/"managers", 10-11 letras cada una, ratio ~1,25):
  // debe seguir contando pese al fix del caso HEMA/Van de Valk (ratio 3,75) — el ratio de largo
  // distingue exactamente estos dos casos.
  assert.equal(puntuarContactoParecido("Hotel 101 Spain Management", "MH APARTMENTS MANAGERS SL") > 0, true);
});

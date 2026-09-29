import assert from "node:assert/strict";
import test from "node:test";
import { puntuarContactoParecido, puntuarDistintividad } from "./write";

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

// Caso real GoTo/LinkedIn (Carlos, Footprint, GoToWebinar, 2026-09-29): un typo REAL ya existente en
// Holded ("Unilimited" en vez de "Unlimited") hacía que el contacto correcto puntuara 0 (su única
// palabra distintiva quedaba invisible al matcher) mientras "Linkedln Ireland Unlimited Company" — sin
// ninguna relación real — ganaba 9 a 0 solo por tener la ortografía correcta de esa palabra. Lista
// sintética que reproduce el patrón real: "Ireland"/"Company"/"Technologies" compartidos por varios
// contactos reales (genéricos, no distintivos), "Unlimited"/"Unilimited" compartido solo por los dos
// contactos en disputa.
const CONTACTOS_GOTO_LINKEDIN = [
  "GoTo Technologies Ireland Unilimited Company",
  "Linkedln Ireland Unlimited Company",
  "ADOBE SYSTEMS SOFTWARE IRELAND Ltd.",
  "Google Ireland Limited",
  "OpenAI Ireland Limited",
  "KOPIE KAARTHOUDER BRUSSELS AIRPORT COMPANY",
  "THE DONER COMPANY",
  "EASYJET AIRLINE COMPANY LIMITED",
  "ZOOM TECHNOLOGIES INC",
  "SLACK TECHNOLOGIES LIMITED",
  "OTRA TECHNOLOGIES SL",
];

test("caso real GoTo/LinkedIn: el typo real de Holded ('Unilimited') ya no deja ganar con confianza a un contacto sin relación", () => {
  const objetivo = "GoTo Technologies Ireland Unlimited Company";
  const correcto = puntuarDistintividad(objetivo, "GoTo Technologies Ireland Unilimited Company", CONTACTOS_GOTO_LINKEDIN);
  const equivocado = puntuarDistintividad(objetivo, "Linkedln Ireland Unlimited Company", CONTACTOS_GOTO_LINKEDIN);
  // Antes del fix: correcto=0, equivocado=9 (ganaba con confianza, error real de bookkeeping).
  // Después del fix: la tolerancia a un typo hace que "Unlimited"~"Unilimited" cuente para ambos —
  // quedan en empate, así que buscarContactoHolded no elige ninguno y pregunta (comportamiento pedido
  // explícitamente por Carlos: "si no tienes seguridad, lo dejas sin contacto o preguntas").
  assert.ok(correcto > 0, `el contacto correcto ya no debe puntuar 0 (obtuvo ${correcto})`);
  assert.equal(correcto, equivocado, `deben empatar en vez de que gane el contacto sin relación (correcto=${correcto}, equivocado=${equivocado})`);
});

test("tolerancia a un typo: sin un competidor que se aproveche del typo, el contacto correcto gana con claridad", () => {
  const objetivo = "GoTo Technologies Ireland Unlimited Company";
  const soloContactoReal = [
    "GoTo Technologies Ireland Unilimited Company",
    "ADOBE SYSTEMS SOFTWARE IRELAND Ltd.",
    "Google Ireland Limited",
    "OpenAI Ireland Limited",
  ];
  const score = puntuarDistintividad(objetivo, "GoTo Technologies Ireland Unilimited Company", soloContactoReal);
  assert.ok(score > 0, `un typo de una sola letra insertada no debe anular la única palabra distintiva (obtuvo ${score})`);
});

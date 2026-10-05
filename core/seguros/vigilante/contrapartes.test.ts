import assert from "node:assert/strict";
import test from "node:test";
import { clasificarContraparte, clavesDePoliza, huellaContraparte, normalizarTexto } from "./contrapartes";

// Descripciones reales de los bancos de Holded (WOBA, EWORKS y Footprint, 2025-10 → 2026-10).
const REALES_DE_SEGUROS: Array<[string, string, string]> = [
  ["N 2026275001954588 Markel Insurance SE ADEUDO A SU CARGO", "markel", "poliza"],
  ["MARKEL INSURANCE, W2764898I641, 033854807074936", "markel", "poliza"],
  ["To Markel Insurance Se Recibo 111190", "markel", "poliza"],
  ["Markel Insurance Se Poliza Recibo 136318 Periodo", "markel", "poliza"],
  ["To Correduria De Seguros Acodrid S A Poliza", "acodrid", "poliza"],
  ["N 2026239000922517 ALLIANZ SEGUROS Y REASEGUROS, S.A. ADEUDO DE ALLIANZ SEGUROS", "allianz", "poliza"],
  ["N 2026273001083953 AEGON ESPANA S.A. ADEUDO DE SEGUROS", "aegon", "fuera_de_alcance"],
  ["Aegon Espa A Salud", "aegon", "fuera_de_alcance"],
  ["N 2026051000247933 PELAYO MUTUA DE SEGUROS -- G-28031466 ADEUDO DE SEGUROS", "pelayo", "fuera_de_alcance"],
  ["Pelayo Mutua", "pelayo", "fuera_de_alcance"],
  ["Iati Colombia", "iati", "puntual"],
  ["Iati Seguros", "iati", "puntual"],
];

test("los cargos reales de seguros se reconocen con su contraparte y su modo", () => {
  for (const [descripcion, clave, modo] of REALES_DE_SEGUROS) {
    const c = clasificarContraparte(descripcion);
    assert.ok(c, `no reconoció «${descripcion}»`);
    assert.equal(c.clave, clave, descripcion);
    assert.equal(c.modo, modo, descripcion);
  }
});

test("lo que NO es un seguro no se reconoce (falsos positivos reales del 27/09 y del 05/10)", () => {
  const noSeguros = [
    "Tokio Sushi",
    "To Sunreuse Association De Valencia", // «iati» dentro de «association»
    "N 2026278001462920 CULLIGAN WATER SPAIN ADEUDO DE AGUA",
    "N 2026271002503712 TGSS. COTIZACION 001 REGIMEN GENERAL CUOTAS DE LA SEGURIDAD SOCIAL",
    "To Bonhomia Asesores S L Recibo Woba",
    "RECIBO UNICO MYBOX, CUOTA AGRUPADA MYBOX 01-10-2026, 086750200007470",
    "To Kelly J. Correales Ducuara", // «reale» dentro de «correales»
    "N 2026260000067455 PROFESSIONAL GROUP CONVERSIA, SL ADEUDO A SU CARGO",
    "Transferencia propia para pago de seg social TRANSFERENCIAS BUSINESS ATELIER EUROPA SL",
    // Movimientos entre cuentas del propio grupo, aunque el concepto hable de seguros (caso real del 01/09/2026).
    "To Business Atelier Europa Sl Transferencia Propia Seguro Resp. Civil",
    "Transferencia propia seguro resp. civil TRANSFERENCIAS",
    "To Business Atelier Europa Sl. Pago Seguro",
    "From Compania De Proyectos Eworks Sl. Pago Seguro",
  ];
  for (const d of noSeguros) assert.equal(clasificarContraparte(d), null, d);
});

test("una aseguradora que el sistema no tiene registrada se marca como desconocida, por nombre o por la palabra «seguros»", () => {
  const mapfre = clasificarContraparte("N 2026301000999999 MAPFRE ESPANA ADEUDO DE SEGUROS");
  assert.equal(mapfre?.modo, "desconocida");
  assert.equal(mapfre?.clave, "mapfre");
  const sinNombre = clasificarContraparte("Seguros Bolivar Colombia");
  assert.equal(sinNombre?.modo, "desconocida");
  assert.equal(sinNombre?.clave, "generica:bolivar-colombia");
});

test("Solunion está dado de baja: un cargo suyo es una anomalía, no un seguro más", () => {
  assert.equal(clasificarContraparte("SOLUNION SEGUROS DE CREDITO ADEUDO")?.modo, "baja");
});

test("la huella de una contraparte no cambia con la remesa ni con el mes", () => {
  assert.equal(huellaContraparte("N 2026252000055653 AEGON ESPANA S.A. ADEUDO DE SEGUROS"), "aegon-espana");
  assert.equal(huellaContraparte("N 2026273001083953 AEGON ESPANA S.A. ADEUDO DE SEGUROS"), "aegon-espana");
  assert.equal(huellaContraparte("ADEUDO DE SEGUROS"), "sin-nombre");
});

test("una póliza se reconoce por su aseguradora y por su correduría", () => {
  assert.deepEqual(clavesDePoliza("Markel Insurance SE", "Acodrid Correduría de Seguros, S.A.").sort(), ["acodrid", "markel"]);
  assert.deepEqual(
    clavesDePoliza("Allianz, Compañía de Seguros y Reaseguros, S.A.", "Acodrid Correduría de Seguros, S.A.").sort(),
    ["acodrid", "allianz"]
  );
  assert.deepEqual(clavesDePoliza("Sin confirmar (posible IATI)", ""), ["iati"]);
  assert.deepEqual(clavesDePoliza("", ""), []);
});

test("la normalización quita tildes y signos", () => {
  assert.equal(normalizarTexto("Correduría de Seguros ACODRID, S.A."), "correduria de seguros acodrid s a");
});

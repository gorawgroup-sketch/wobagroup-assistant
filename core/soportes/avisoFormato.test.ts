import assert from "node:assert/strict";
import test from "node:test";
import { agruparDestinatarios, ASUNTO_AVISO_FORMATO, estaExcluido, redactarAvisoFormato } from "./avisoFormato";
import { EJEMPLO_ASUNTO_SOPORTE, INSTRUCCIONES_ENVIO_SOPORTES, redactarCorreoSoportes } from "./redactarCorreoSoportes";
import { HERRAMIENTAS_PERMITIDAS } from "../tools/proponerAccionAdmin";
import { avisoFormatoSoportesTool } from "../tools/avisoFormatoSoportes";
import { esAccionSensible } from "../telegram/authorizedUsersSheet";

/**
 * Aviso de formato de soportes (Carlos, 2026-10-14): una persona = un correo, solo con email confirmado, texto fijo con las instrucciones
 * de envío (correo aparte, asunto con detalle/valor/moneda/empresa) y nada sale sin el botón de un superadministrador.
 */
const SOLICITANTES = [
  { empresa: "Footprint", titular: "Alberto Comolli" }, { empresa: "WOBA", titular: "Alberto Comolli" }, { empresa: "EWORKS", titular: "Alberto Comolli" },
  { empresa: "Footprint", titular: "Yessenia Carolina Dos Prazeres Ferreira" }, { empresa: "WOBA", titular: "Yessenia Carolina Dos Prazeres Ferreira" },
  { empresa: "Footprint", titular: "Simon Talloen" }, { empresa: "WOBA", titular: "Carlos Alberto Gonzalez Guerrero" },
  { empresa: "Footprint", titular: "BUSINESS FOOTPRINT EU, SOCIEDAD LIMITADA" }, { empresa: "Footprint", titular: "Persona Sin Correo" },
];
const EMAILS: Record<string, string> = {
  "Alberto Comolli": "Alberto@footprint.global", "Yessenia Carolina Dos Prazeres Ferreira": "yessenia@footprint.global",
  "Simon Talloen": "simon@footprint.global", "Carlos Alberto Gonzalez Guerrero": "carlos@wobagroup.com",
};
const resolver = async (t: string) => EMAILS[t];

test("una persona = un correo aunque se le pidiera en varias empresas; sin email o sociedad no se escribe", async () => {
  const r = await agruparDestinatarios(SOLICITANTES, resolver, ["Carlos Gonzalez"]);
  assert.deepEqual(r.destinatarios.map((d) => [d.titular, d.email, d.empresas]), [
    ["Alberto Comolli", "alberto@footprint.global", ["EWORKS", "Footprint", "WOBA"]],
    ["Simon Talloen", "simon@footprint.global", ["Footprint"]],
    ["Yessenia Carolina Dos Prazeres Ferreira", "yessenia@footprint.global", ["Footprint", "WOBA"]],
  ]);
  assert.deepEqual(r.sinEmail, ["Persona Sin Correo"]); assert.deepEqual(r.excluidos, ["Carlos Alberto Gonzalez Guerrero"]);
  assert.equal(r.sociedades.length, 1);
});

test("dos nombres distintos con el mismo email son la misma persona; un nombre suelto no excluye a nadie", async () => {
  const r = await agruparDestinatarios([{ empresa: "WOBA", titular: "Alberto C." }, { empresa: "Footprint", titular: "Alberto Comolli" }], async () => "alberto@footprint.global");
  assert.equal(r.destinatarios.length, 1);
  assert.equal(estaExcluido("Carlos Alberto Gonzalez Guerrero", ["Carlos"]), false);
  assert.equal(estaExcluido("Carlos Alberto Gonzalez Guerrero", ["carlos gonzalez"]), true);
});

test("el aviso agradece, explica el envío (correo aparte, asunto con detalle/valor/moneda/empresa) y no pide reenviar lo ya enviado", () => {
  const t = redactarAvisoFormato({ titular: "Yessenia Carolina Dos Prazeres Ferreira", empresas: ["Footprint", "WOBA"] });
  assert.match(t, /^Hola, Yessenia:/);
  assert.match(t, /de Footprint y WOBA/);
  assert.match(t, /agradecemos mucho tu atención/);
  for (const i of INSTRUCCIONES_ENVIO_SOPORTES) assert.ok(t.includes(i));
  assert.match(t, /APARTE y nuevo/); assert.match(t, /No respondas al correo/); assert.match(t, /detalle del gasto, el valor, la moneda/);
  assert.ok(t.includes(EJEMPLO_ASUNTO_SOPORTE));
  assert.match(t, /no hace falta que lo reenvíes/);
  assert.doesNotMatch(t, /respondiendo a este correo/);
  assert.ok(ASUNTO_AVISO_FORMATO.length > 10);
});

test("con hoja de seguimiento el aviso la enlaza; sin ella pide la fecha y el destinatario por respuesta", () => {
  assert.match(redactarAvisoFormato({ titular: "Simon Talloen", empresas: ["Footprint"], hojaUrl: "https://docs.google.com/spreadsheets/d/abc" }), /https:\/\/docs\.google\.com\/spreadsheets\/d\/abc/);
  assert.match(redactarAvisoFormato({ titular: "Simon Talloen", empresas: ["Footprint"] }), /respóndenos con la fecha y el destinatario/);
});

test("el correo de solicitud de soportes usa las mismas instrucciones (fuente única) y ya no pide responder a él", () => {
  const t = redactarCorreoSoportes({ titular: "Simon Talloen", empresa: "Footprint", desde: "2026-09-01", hasta: "2026-10-06", cargos: [] });
  for (const i of INSTRUCCIONES_ENVIO_SOPORTES) assert.ok(t.includes(i));
  assert.doesNotMatch(t, /respondiendo a este correo/);
});

test("la herramienta solo prepara: existe, está entre las acciones de administración que solo proponen y su botón de envío es sensible", () => {
  assert.equal(avisoFormatoSoportesTool.name, "preparar_aviso_formato_soportes");
  assert.equal(HERRAMIENTAS_PERMITIDAS.has("preparar_aviso_formato_soportes"), true);
  assert.equal(esAccionSensible("sop_ae:abc12345"), true);
  assert.equal(esAccionSensible("sop_av:abc12345"), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { aplicarExclusiones, agruparPorEmail, estaExcluido } from "./destinatarios";
import { construirAudienciaSoportes, idsAudiencias, registrarAudiencia, resolverAudiencia } from "./audiencias";
import { marcasDesconocidas, renderizar } from "./plantilla";
import { resolverPeticion, textoResumen, MAX_DESTINATARIOS } from "./envioMasivoTelegram";
import { HERRAMIENTAS_PERMITIDAS } from "../tools/proponerAccionAdmin";
import { proponerCorreoAAudienciaTool } from "../tools/proponerCorreoAAudiencia";
import { esAccionSensible } from "../telegram/authorizedUsersSheet";
import { INSTRUCCIONES_ENVIO_SOPORTES, redactarCorreoSoportes } from "../soportes/redactarCorreoSoportes";

/**
 * Correo a una audiencia (Carlos, 2026-10-14): general — el texto lo redacta el chat según la orden, la audiencia sale de un registro abierto,
 * una persona = un correo, nunca se adivina un email y nada sale sin el botón «Enviar» de un superadministrador.
 */
const SOLICITANTES = [
  { empresa: "Footprint", titular: "Alberto Comolli" }, { empresa: "WOBA", titular: "Alberto Comolli" }, { empresa: "EWORKS", titular: "Alberto Comolli" },
  { empresa: "Footprint", titular: "Yessenia Carolina Dos Prazeres Ferreira" }, { empresa: "WOBA", titular: "Yessenia Carolina Dos Prazeres Ferreira" },
  { empresa: "Footprint", titular: "Simon Talloen" }, { empresa: "WOBA", titular: "Carlos Alberto Gonzalez Guerrero" },
  { empresa: "Footprint", titular: "BUSINESS FOOTPRINT EU, SOCIEDAD LIMITADA" }, { empresa: "Footprint", titular: "Persona Sin Correo" },
];
const EMAILS: Record<string, string> = {
  "Alberto Comolli": "alberto@footprint.global", "Yessenia Carolina Dos Prazeres Ferreira": "yessenia@footprint.global",
  "Simon Talloen": "simon@footprint.global", "Carlos Alberto Gonzalez Guerrero": "carlos@wobagroup.com",
};
const resolver = async (t: string) => EMAILS[t];

test("audiencia de soportes: una persona = un correo aunque se le pidiera en varias empresas; sin email o sociedad no se escribe", async () => {
  const r = await construirAudienciaSoportes(SOLICITANTES, resolver);
  assert.deepEqual(r.destinatarios.map((d) => [d.nombre, d.email, d.empresas]), [
    ["Alberto Comolli", "alberto@footprint.global", ["EWORKS", "Footprint", "WOBA"]],
    ["Carlos Alberto Gonzalez Guerrero", "carlos@wobagroup.com", ["WOBA"]],
    ["Simon Talloen", "simon@footprint.global", ["Footprint"]],
    ["Yessenia Carolina Dos Prazeres Ferreira", "yessenia@footprint.global", ["Footprint", "WOBA"]],
  ]);
  assert.deepEqual(r.sinEmail, ["Persona Sin Correo"]); assert.equal(r.omitidos.length, 1);
  assert.deepEqual((await construirAudienciaSoportes(SOLICITANTES, resolver, "wOBA")).destinatarios.map((d) => d.nombre), ["Alberto Comolli", "Carlos Alberto Gonzalez Guerrero", "Yessenia Carolina Dos Prazeres Ferreira"]);
});

test("agrupar por email (no por nombre), descartar emails inválidos y excluir por nombre y apellido", () => {
  const g = agruparPorEmail([{ nombre: "Alberto C.", email: "Alberto@footprint.global", empresa: "WOBA" }, { nombre: "Alberto Comolli", email: "alberto@footprint.global", empresa: "Footprint" }, { nombre: "X", email: "no-es-email" }]);
  assert.equal(g.length, 1); assert.deepEqual(g[0].empresas, ["Footprint", "WOBA"]);
  assert.equal(estaExcluido("Carlos Alberto Gonzalez Guerrero", ["Carlos"]), false);
  assert.equal(estaExcluido("Carlos Alberto Gonzalez Guerrero", ["carlos gonzalez"]), true);
  const { quedan, excluidos } = aplicarExclusiones(agruparPorEmail([{ nombre: "Carlos Alberto Gonzalez Guerrero", email: "carlos@wobagroup.com" }, { nombre: "Simon Talloen", email: "simon@footprint.global" }]), ["Carlos Gonzalez"]);
  assert.deepEqual(quedan.map((d) => d.nombre), ["Simon Talloen"]); assert.deepEqual(excluidos, ["Carlos Alberto Gonzalez Guerrero"]);
});

test("plantilla: {nombre}, {nombre_completo} y {empresas} se sustituyen por persona; una marca desconocida se detecta", () => {
  const d = { nombre: "Yessenia Carolina Dos Prazeres Ferreira", empresas: ["Footprint", "WOBA"] };
  assert.equal(renderizar("Hola, {nombre}: gastos de {empresas} ({nombre_completo}).", d), "Hola, Yessenia: gastos de Footprint y WOBA (Yessenia Carolina Dos Prazeres Ferreira).");
  assert.deepEqual(marcasDesconocidas("Hola {nombre} {apellido} {x_y}"), ["apellido", "x_y"]);
  assert.deepEqual(marcasDesconocidas("Hola {nombre}"), []);
});

test("el registro de audiencias es abierto: un módulo nuevo registra la suya y el chat la usa sin código nuevo", async () => {
  assert.ok(idsAudiencias().includes("solicitud_soportes") && idsAudiencias().includes("directorio") && idsAudiencias().includes("lista"));
  registrarAudiencia({ id: "prueba_equipo", descripcion: "x", parametros: "-", resolver: async () => ({ destinatarios: agruparPorEmail([{ nombre: "Ana Pérez", email: "ana@wobagroup.com" }]), sinEmail: [], omitidos: [] }) });
  const r = await resolverPeticion({ audiencia: "prueba_equipo", asunto: "Aviso importante para el equipo", cuerpo: "Hola, {nombre}: este es un aviso para todo el equipo de la empresa." });
  assert.equal(r.error, undefined); assert.deepEqual(r.destinatarios.map((d) => d.email), ["ana@wobagroup.com"]);
  await assert.rejects(() => resolverAudiencia("no_existe"), /No existe la audiencia/);
});

test("la audiencia «lista» valida los emails que da quien pide el envío", async () => {
  const r = await resolverAudiencia("lista", { destinatarios: [{ nombre: "Ana", email: "ana@x.com" }, { nombre: "Sin arroba", email: "ana.x.com" }] });
  assert.deepEqual(r.destinatarios.map((d) => d.email), ["ana@x.com"]); assert.deepEqual(r.sinEmail, ["Sin arroba"]);
});

test("una petición se rechaza con motivo claro: cuerpo vacío, marcas inexistentes o demasiadas personas", async () => {
  assert.match((await resolverPeticion({ audiencia: "lista", asunto: "", cuerpo: "" })).error ?? "", /Faltan el asunto/);
  assert.match((await resolverPeticion({ audiencia: "lista", asunto: "Aviso", cuerpo: "Hola {apellido}, este es un cuerpo suficientemente largo." })).error ?? "", /\{apellido\}/);
  const muchos = Array.from({ length: MAX_DESTINATARIOS + 1 }, (_, i) => ({ nombre: `P${i}`, email: `p${i}@x.com` }));
  assert.match((await resolverPeticion({ audiencia: "lista", parametros: { destinatarios: muchos }, asunto: "Aviso", cuerpo: "Hola {nombre}, este es un cuerpo suficientemente largo." })).error ?? "", /máximo por envío/);
});

test("el resumen muestra asunto, personas, advertencias de reenvío y exclusiones, y recuerda que nada sale sin «Enviar»", () => {
  const t = textoResumen({ asunto: "Aviso", descripcion: "Formato de soportes" }, [{ nombre: "Simon Talloen", email: "simon@footprint.global", empresas: ["Footprint"], estado: "pendiente" }], { yaEnviado: ["simon@footprint.global"], sinEmail: ["Fulano"], excluidos: ["Carlos"] });
  assert.match(t, /Asunto: Aviso/); assert.match(t, /ya se les envió/); assert.match(t, /Sin email/); assert.match(t, /Excluidos/); assert.match(t, /Nada sale hasta que pulses «Enviar»/);
});

test("la herramienta solo prepara: está entre las acciones de administración que solo proponen y su botón de envío es sensible", () => {
  assert.equal(proponerCorreoAAudienciaTool.name, "proponer_correo_a_audiencia");
  assert.equal(HERRAMIENTAS_PERMITIDAS.has("proponer_correo_a_audiencia"), true);
  assert.equal(esAccionSensible("cm_e:abc12345"), true);
  assert.equal(esAccionSensible("cm_v:abc12345"), false);
  assert.equal(esAccionSensible("cm_c:abc12345"), false);
});

test("el correo de solicitud de soportes usa las instrucciones de envío unificadas y ya no pide responder a él", () => {
  const t = redactarCorreoSoportes({ titular: "Simon Talloen", empresa: "Footprint", desde: "2026-09-01", hasta: "2026-10-06", cargos: [] });
  for (const i of INSTRUCCIONES_ENVIO_SOPORTES) assert.ok(t.includes(i));
  assert.doesNotMatch(t, /respondiendo a este correo/);
});

test("el propio buzón de Wobi nunca es destinatario", async () => {
  registrarAudiencia({ id: "prueba_buzon", descripcion: "x", parametros: "-", resolver: async () => ({ destinatarios: agruparPorEmail([{ nombre: "Admin Asistente", email: "asistente@wobagroup.com" }, { nombre: "Ana Pérez", email: "ana@wobagroup.com" }]), sinEmail: [], omitidos: [] }) });
  const r = await resolverPeticion({ audiencia: "prueba_buzon", asunto: "Aviso importante", cuerpo: "Hola, {nombre}: este es un aviso suficientemente largo para el equipo." });
  assert.deepEqual(r.destinatarios.map((d) => d.email), ["ana@wobagroup.com"]);
});

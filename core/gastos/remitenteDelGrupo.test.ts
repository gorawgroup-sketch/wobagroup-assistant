import assert from "node:assert/strict";
import test from "node:test";
import { esRemitenteDelGrupo } from "./remitenteDelGrupo";

const env = {} as NodeJS.ProcessEnv;

test("reconoce a un empleado por la dirección real entre ángulos", () => {
  assert.equal(esRemitenteDelGrupo("Juan Camilo Salazar <juanc.salazar@footprint.global>", env), true);
  assert.equal(esRemitenteDelGrupo("Carlos Gonzalez <carlos@wobagroup.com>", env), true);
  assert.equal(esRemitenteDelGrupo("carlos@wobagroup.com", env), true);
});

test("un nombre visible con dominio del grupo no engaña: manda la dirección real", () => {
  assert.equal(esRemitenteDelGrupo('"alberto@wobagroup.com" <atacante@otrodominio.com>', env), false);
  assert.equal(esRemitenteDelGrupo("Proveedor <facturas@wobagroup.com.estafa.io>", env), false);
});

test("proveedores externos, vacíos y subdominios ajenos no son del grupo", () => {
  assert.equal(esRemitenteDelGrupo("Uber Receipts <noreply@uber.com>", env), false);
  assert.equal(esRemitenteDelGrupo(undefined, env), false);
  assert.equal(esRemitenteDelGrupo("", env), false);
});

test("los dominios se pueden ampliar por entorno", () => {
  const otro = { WOBI_DOMINIOS_GRUPO: "ejemplo.org, @wobagroup.com" } as unknown as NodeJS.ProcessEnv;
  assert.equal(esRemitenteDelGrupo("Ana <ana@ejemplo.org>", otro), true);
  assert.equal(esRemitenteDelGrupo("Juan <j@footprint.global>", otro), false);
});

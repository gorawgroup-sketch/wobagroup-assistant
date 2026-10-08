import assert from "node:assert/strict";
import test from "node:test";
import { COMANDOS_MENU, parsearComandoTransferencias } from "./menuComandos";

test("el comando del menú y la orden escrita piden lo mismo", () => {
  assert.equal(parsearComandoTransferencias("/transferencias"), "todas");
  assert.equal(parsearComandoTransferencias("/transferencias@WobiBot"), "todas");
  assert.equal(parsearComandoTransferencias("/transferencias woba"), "WOBA");
  assert.equal(parsearComandoTransferencias("Revisa las transferencias internas de WOBA"), "WOBA");
  assert.equal(parsearComandoTransferencias("revisar transferencias de Footprint"), "Footprint");
  assert.equal(parsearComandoTransferencias("transferencias internas eworks"), "EWORKS");
});

test("una frase que solo menciona transferencias no dispara el comando", () => {
  assert.equal(parsearComandoTransferencias("¿cuántas transferencias hizo WOBA en septiembre?"), undefined);
  assert.equal(parsearComandoTransferencias("transferencias de Nuria"), undefined);
  assert.equal(parsearComandoTransferencias("haz las transferencias a los proveedores hoy"), undefined);
});

test("el menú cumple las reglas de Telegram: minúsculas, sin espacios, descripción corta", () => {
  for (const c of COMANDOS_MENU) {
    assert.match(c.command, /^[a-z0-9_]{1,32}$/);
    assert.ok(c.description.length >= 3 && c.description.length <= 256);
  }
  assert.deepEqual(COMANDOS_MENU.map((c) => c.command), ["revisarcorreo", "soportes", "transferencias", "preguntas", "conocimiento"]);
});

test("«/soportes» y «pedir soportes» arrancan el proceso, con o sin empresa", async () => {
  const { parsearComandoSoportes } = await import("./menuComandos");
  assert.deepEqual(parsearComandoSoportes("/soportes"), {});
  assert.deepEqual(parsearComandoSoportes("/soportes@WobiBot"), {});
  assert.deepEqual(parsearComandoSoportes("/soportes woba"), { empresa: "WOBA" });
  assert.deepEqual(parsearComandoSoportes("Pedir soportes de Footprint"), { empresa: "Footprint" });
  assert.deepEqual(parsearComandoSoportes("pedir soportes de las tarjetas"), {});
  assert.deepEqual(parsearComandoSoportes("/soportes eworks"), { empresa: "EWORKS" });
});

test("una frase que solo menciona soportes no arranca el proceso", async () => {
  const { parsearComandoSoportes } = await import("./menuComandos");
  assert.equal(parsearComandoSoportes("¿qué soportes faltan de Nuria?"), undefined);
  assert.equal(parsearComandoSoportes("necesito pedir soportes a Alberto por el hotel"), undefined);
  assert.equal(parsearComandoSoportes("soportes"), undefined);
});

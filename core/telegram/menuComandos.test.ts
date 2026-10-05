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
  assert.deepEqual(COMANDOS_MENU.map((c) => c.command), ["revisarcorreo", "transferencias", "preguntas"]);
});

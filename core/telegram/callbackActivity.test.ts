import assert from "node:assert/strict";
import test from "node:test";
import { hayActividadCallbackReciente, iniciarActividadCallback } from "./callbackActivity";

test("mantiene el chat protegido mientras un callback sigue activo", () => {
  const chatId = 91001;
  const terminarPrimera = iniciarActividadCallback(chatId);
  const terminarSegunda = iniciarActividadCallback(chatId);

  assert.equal(hayActividadCallbackReciente(chatId, 0, 0), true);
  terminarPrimera();
  assert.equal(hayActividadCallbackReciente(chatId, 0, 0), true);
  terminarSegunda();
});

test("conserva un margen tras terminar y luego libera el chat", () => {
  const chatId = 91002;
  const terminar = iniciarActividadCallback(chatId);
  terminar();

  const justoAhora = Date.now();
  assert.equal(hayActividadCallbackReciente(chatId, justoAhora, 60_000), true);
  assert.equal(hayActividadCallbackReciente(chatId, justoAhora + 60_001, 60_000), false);
});


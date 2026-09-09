import assert from "node:assert/strict";
import test from "node:test";
import { chatIdAisladoParaDevice, esDeviceIdValido } from "./webChatIdentity";

test("la identidad web aislada es estable, negativa y distinta por dispositivo", () => {
  const a = chatIdAisladoParaDevice("device_1234567890abcdef", "Carlos");
  const b = chatIdAisladoParaDevice("device_fedcba0987654321", "Carlos");
  assert.equal(a, chatIdAisladoParaDevice("device_1234567890abcdef", "Carlos"));
  assert.ok(a < 0);
  assert.notEqual(a, b);
  assert.notEqual(a, chatIdAisladoParaDevice("device_1234567890abcdef", "Otra persona"));
});

test("solo acepta identificadores de dispositivo acotados", () => {
  assert.equal(esDeviceIdValido("device_1234567890abcdef"), true);
  assert.equal(esDeviceIdValido("corto"), false);
  assert.equal(esDeviceIdValido("../../un-device-invalido"), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { extraerCodigoVinculoChat } from "./chatLinkCommand";

test("reconoce el código de vinculación escrito en Telegram", () => {
  assert.equal(extraerCodigoVinculoChat("VINCULAR YC6-4CU"), "YC6-4CU");
  assert.equal(extraerCodigoVinculoChat("/vincular yc64cu"), "yc64cu");
});

test("reconoce enlaces profundos de Telegram", () => {
  assert.equal(extraerCodigoVinculoChat("/start vincular_YC64CU"), "YC64CU");
  assert.equal(extraerCodigoVinculoChat("/start@Woba_asistente_bot link-YC6-4CU"), "YC6-4CU");
});

test("no confunde mensajes normales con una vinculación", () => {
  assert.equal(extraerCodigoVinculoChat("quiero vincular Telegram"), undefined);
  assert.equal(extraerCodigoVinculoChat("/start"), undefined);
});

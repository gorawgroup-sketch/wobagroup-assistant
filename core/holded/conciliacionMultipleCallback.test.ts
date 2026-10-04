import assert from "node:assert/strict";
import test from "node:test";
import { crearHandlerConciliacionMultiple } from "./conciliacionMultiple/callback";
import type { TelegramCallbackQuery } from "../telegram/types";

function fixture() {
  const decisiones: unknown[][] = [];
  const mensajes: string[] = [];
  let autorizado = false;
  const handler = crearHandlerConciliacionMultiple({
    servicio: { async decidir(...args) { decisiones.push(args); throw new Error("Plan incierto de prueba"); } },
    async puedeAprobar() { return autorizado; },
    async responder(_id, texto) { mensajes.push(texto); },
    async enviar(_id, texto) { mensajes.push(texto); },
  });
  const callback: TelegramCallbackQuery = { id: "callback", from: { id: 7, is_bot: false }, data: "concilmulti_si:plan",
    message: { message_id: 1, chat: { id: 123, type: "private" }, date: 0 } };
  return { handler, callback, decisiones, mensajes, autorizar() { autorizado = true; } };
}
test("callback exige superadministrador para aprobar o cancelar", async () => {
  const f = fixture();
  await f.handler(f.callback);
  await f.handler({ ...f.callback, data: "concilmulti_no:plan" });
  assert.equal(f.decisiones.length, 0);
  assert.ok(f.mensajes.every((m) => m.includes("superadministrador")));
});
test("callback no interpreta acciones desconocidas o parámetros extras como aprobación", async () => {
  const f = fixture(); f.autorizar();
  for (const data of ["concilmulti_x:plan", "concilmulti_si:plan:extra", "concilmulti_si:", undefined]) {
    await f.handler({ ...f.callback, data });
  }
  await f.handler({ ...f.callback, message: undefined });
  assert.equal(f.decisiones.length, 0);
});
test("callback propaga chat y aprobador; los errores nunca dicen resuelto", async () => {
  const f = fixture(); f.autorizar(); await f.handler(f.callback);
  assert.deepEqual(f.decisiones, [["plan", 123, 7, true]]);
  assert.match(f.mensajes.at(-1)!, /No se da por conciliado ni por resuelto/);
});

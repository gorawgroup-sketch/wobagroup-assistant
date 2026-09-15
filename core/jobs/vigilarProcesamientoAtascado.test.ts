import assert from "node:assert/strict";
import test from "node:test";
import { coincideCorreoPendiente } from "./vigilarProcesamientoAtascado";

test("coincide por mensajeId exacto", () => {
  assert.equal(
    coincideCorreoPendiente({ mensajeIdGmail: "msg-1", threadId: "thread-1" }, "msg-1", "thread-otro"),
    true
  );
});

test("caso real Carlos (2026-09-15): coincide por threadId aunque activo.mensajeId haya cambiado de mensaje dentro del mismo hilo", () => {
  // activo.mensajeId se actualiza en cada reintento al ÚLTIMO mensaje del hilo (ver
  // reencolarActivoParaReintento), que puede no ser el mismo mensaje puntual que
  // procesarGastoEntrante procesó y guardó en correoOrigen — el threadId es estable.
  assert.equal(
    coincideCorreoPendiente({ mensajeIdGmail: "msg-original", threadId: "thread-1" }, "msg-mas-reciente-del-hilo", "thread-1"),
    true
  );
});

test("no coincide si ni el mensaje ni el hilo son el mismo", () => {
  assert.equal(
    coincideCorreoPendiente({ mensajeIdGmail: "msg-1", threadId: "thread-1" }, "msg-2", "thread-2"),
    false
  );
});

test("un origen indefinido nunca coincide", () => {
  assert.equal(coincideCorreoPendiente(undefined, "msg-1", "thread-1"), false);
});

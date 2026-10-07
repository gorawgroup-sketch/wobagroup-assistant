import assert from "node:assert/strict";
import test from "node:test";
import { propuestaEnMensajePulsado } from "./propuestaMensajePulsado";

const propuesta = { id: "2e3842c8", chatId: 77, messageId: 6213 } as never;
const cb = (message?: { message_id: number; chat: { id: number } }) => ({ id: "c", data: "gasto_toggle:2e3842c8:crear", message }) as never;

test("si el botón se pulsó en otro mensaje que el guardado, los cambios van al mensaje pulsado aunque no se pueda guardar el nuevo id", async () => {
  const antes = process.env.CASHFLOW_SHEET_ID; delete process.env.CASHFLOW_SHEET_ID; // sin Sheets: la persistencia falla y no debe impedir el cambio
  const silenciar = console.error; console.error = () => undefined;
  try {
    const r = await propuestaEnMensajePulsado(cb({ message_id: 6300, chat: { id: 77 } }), propuesta);
    assert.equal(r.messageId, 6300);
    assert.equal(r.id, "2e3842c8");
  } finally { console.error = silenciar; if (antes !== undefined) process.env.CASHFLOW_SHEET_ID = antes; }
});

test("si el mensaje pulsado es el guardado, o no se conoce, o es de otro chat, la propuesta no cambia", async () => {
  assert.equal((await propuestaEnMensajePulsado(cb({ message_id: 6213, chat: { id: 77 } }), propuesta)).messageId, 6213);
  assert.equal((await propuestaEnMensajePulsado(cb(undefined), propuesta)).messageId, 6213);
  assert.equal((await propuestaEnMensajePulsado(cb({ message_id: 9999, chat: { id: 5 } }), propuesta)).messageId, 6213);
  assert.equal((await propuestaEnMensajePulsado(cb({ message_id: 0, chat: { id: 77 } }), propuesta)).messageId, 6213);
});

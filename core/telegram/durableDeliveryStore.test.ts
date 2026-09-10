import assert from "node:assert/strict";
import test from "node:test";
import { cifrarPayloadDurable, descifrarPayloadDurable } from "./durableDeliveryStore";

test("el payload durable queda cifrado y autenticado", () => {
  const clave = Buffer.alloc(32, 7);
  const original = JSON.stringify({ update_id: 123, message: { text: "dato sensible" } });
  const cifrado = cifrarPayloadDurable(original, clave);
  assert.match(cifrado, /^v1:/);
  assert.equal(cifrado.includes("dato sensible"), false);
  assert.equal(descifrarPayloadDurable(cifrado, clave), original);
});

test("un payload alterado o una clave distinta nunca se interpreta", () => {
  const clave = Buffer.alloc(32, 3);
  const cifrado = cifrarPayloadDurable("contenido", clave);
  const alterado = `${cifrado.slice(0, -1)}${cifrado.endsWith("A") ? "B" : "A"}`;
  assert.equal(descifrarPayloadDurable(alterado, clave), "");
  assert.equal(descifrarPayloadDurable(cifrado, Buffer.alloc(32, 4)), "");
});

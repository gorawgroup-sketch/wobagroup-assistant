import assert from "node:assert/strict";
import test from "node:test";
import { registrarCapturaIdempotenteUnaVez } from "./capturaSheet";

test("dos registros concurrentes con la misma clave anexan una sola captura", async () => {
  let existe = false;
  let anexos = 0;
  const dependencias = {
    existe: async () => existe,
    anexar: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      anexos += 1;
      existe = true;
    },
  };
  const mutex = `capturaSheet:test:${Date.now()}:${Math.random()}`;

  const resultados = await Promise.all([
    registrarCapturaIdempotenteUnaVez("captura-estable", dependencias, mutex),
    registrarCapturaIdempotenteUnaVez("captura-estable", dependencias, mutex),
  ]);

  assert.equal(anexos, 1);
  assert.deepEqual(resultados.sort(), ["creada", "existente"]);
});

test("un ACK incierto se confirma por lectura y no exige repetir el append", async () => {
  let existe = false;
  let anexos = 0;
  const resultado = await registrarCapturaIdempotenteUnaVez(
    "captura-ack-incierto",
    {
      existe: async () => existe,
      anexar: async () => {
        anexos += 1;
        existe = true;
        throw new Error("timeout después del commit");
      },
    },
    `capturaSheet:ack:${Date.now()}:${Math.random()}`
  );

  assert.equal(resultado, "existente");
  assert.equal(anexos, 1);
});


import assert from "node:assert/strict";
import test from "node:test";
import {
  consumirResolucionContactoUnaVez,
  type DependenciasConsumoResolucionContacto,
  type ResolucionContactoPendiente,
} from "./contactoResolucionStore";
import type { PropuestaGasto } from "./gastoProposalSheet";

function crearResolucion(id: string): ResolucionContactoPendiente {
  return {
    id,
    propuesta: { id: `propuesta-${id}` } as PropuestaGasto,
    empresaFinal: "Footprint",
    conceptoFinal: "alimentación",
    alternativas: [],
    chatId: 77,
    messageId: 500,
    creadoEn: Date.now(),
  };
}

test("dos callbacks concurrentes consumen una resolución una sola vez y conservan la vecina", async () => {
  const filas = [crearResolucion("contacto-1"), crearResolucion("contacto-2")];
  const dependencias: DependenciasConsumoResolucionContacto = {
    leer: async () => filas.map((resolucion, indice) => ({ rowIndex: indice + 2, resolucion })),
    eliminar: async (rowIndex) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      filas.splice(rowIndex - 2, 1);
    },
  };
  const mutex = `contactoResolucion:test:${Date.now()}:${Math.random()}`;

  const resultados = await Promise.all([
    consumirResolucionContactoUnaVez("contacto-1", dependencias, mutex),
    consumirResolucionContactoUnaVez("contacto-1", dependencias, mutex),
  ]);

  assert.equal(resultados.filter(Boolean).length, 1);
  assert.deepEqual(filas.map((fila) => fila.id), ["contacto-2"]);
});


import assert from "node:assert/strict";
import test from "node:test";
import {
  guardarPendienteOrientacionUnaVez,
  reclamarPendienteOrientacionUnaVez,
  type DependenciasOrientacionCorreo,
  type PendienteOrientacionCorreo,
} from "./emailOrientationStore";

function pendiente(
  mensajeId: string,
  messageId: number,
  creadoEn = Date.now()
): PendienteOrientacionCorreo {
  return {
    chatId: 42,
    messageId,
    de: "proveedor@example.com",
    asunto: `Correo ${mensajeId}`,
    resumen: "Resumen",
    threadId: `thread-${mensajeId}`,
    messageIdHeader: `<${mensajeId}@example.com>`,
    mensajeId,
    deColaCorreo: true,
    creadoEn,
  };
}

function memoria(iniciales: PendienteOrientacionCorreo[]) {
  const filas = [...iniciales];
  const dependencias: DependenciasOrientacionCorreo = {
    leer: async () => filas.map((p, indice) => ({ rowIndex: indice + 2, pendiente: p })),
    eliminar: async (rowIndex) => {
      filas.splice(rowIndex - 2, 1);
    },
    agregar: async (p) => {
      filas.push(p);
    },
  };
  return { filas, dependencias };
}

test("una orientación nueva no reemplaza la de otro correo del mismo chat", async () => {
  const primera = pendiente("gmail-a", 100);
  const segunda = pendiente("gmail-b", 101);
  const { filas, dependencias } = memoria([primera]);
  const { creadoEn: _creadoEn, ...datosSegunda } = segunda;

  await assert.rejects(
    guardarPendienteOrientacionUnaVez(
      datosSegunda,
      dependencias,
      `emailOrientationStore:test:guardar:${Date.now()}:${Math.random()}`
    ),
    /otro correo/
  );
  assert.deepEqual(filas.map((p) => p.mensajeId), ["gmail-a"]);
});

test("dos orientaciones ambiguas no consumen ni borran ninguna fila", async () => {
  const { filas, dependencias } = memoria([
    pendiente("gmail-a", 100),
    pendiente("gmail-b", 101),
  ]);

  const resultado = await reclamarPendienteOrientacionUnaVez(
    42,
    dependencias,
    `emailOrientationStore:test:ambigua:${Date.now()}:${Math.random()}`
  );

  assert.deepEqual(resultado, { estado: "ambigua", cantidad: 2 });
  assert.deepEqual(filas.map((p) => p.mensajeId), ["gmail-a", "gmail-b"]);
});

test("dos reclamos concurrentes consumen una orientación una sola vez", async () => {
  const { filas, dependencias } = memoria([pendiente("gmail-a", 100)]);
  const clave = `emailOrientationStore:test:claim:${Date.now()}:${Math.random()}`;

  const resultados = await Promise.all([
    reclamarPendienteOrientacionUnaVez(42, dependencias, clave),
    reclamarPendienteOrientacionUnaVez(42, dependencias, clave),
  ]);

  assert.equal(resultados.filter((r) => r.estado === "consumida").length, 1);
  assert.equal(resultados.filter((r) => r.estado === "ninguna").length, 1);
  assert.equal(filas.length, 0);
});

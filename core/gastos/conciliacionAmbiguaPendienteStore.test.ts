import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  consumirConciliacionAmbiguaUnaVez,
  deserializarFilaConciliacionAmbigua,
  guardarConciliacionAmbiguaPendiente,
  serializarFilaConciliacionAmbigua,
  type ConciliacionAmbiguaPendiente,
  type DependenciasConsumoConciliacionAmbigua,
} from "./conciliacionAmbiguaPendienteStore";
import { guardarConciliacionPendiente } from "./conciliacionPendienteStore";

test("una fila legacy sin threadId conserva sus columnas y no inventa identidad", () => {
  const legacy = [
    "ambigua-legacy",
    "Footprint",
    "gasto-legacy",
    "Gasto legacy",
    "42",
    "1700000000000",
    "[]",
    "true",
    "false",
    "Proveedor legacy",
    "gmail-message-legacy",
    "true",
  ];

  const pendiente = deserializarFilaConciliacionAmbigua(legacy);
  assert.equal(pendiente.mensajeIdGmail, "gmail-message-legacy");
  assert.equal(pendiente.comprobanteConfirmado, true);
  assert.equal(pendiente.threadIdGmail, undefined);
});

test("una fila nueva persiste mensaje y thread de Gmail sin desplazar campos históricos", () => {
  const pendiente: ConciliacionAmbiguaPendiente = {
    id: "ambigua-nueva",
    empresa: "Footprint",
    gastoId: "gasto-nuevo",
    descripcionGasto: "Gasto nuevo",
    chatId: 42,
    creadoEn: 1_700_000_000_000,
    candidatos: [],
    deColaCorreo: true,
    esAproximado: false,
    proveedor: "Proveedor",
    mensajeIdGmail: "gmail-message",
    comprobanteConfirmado: true,
    threadIdGmail: "gmail-thread",
  };

  const fila = serializarFilaConciliacionAmbigua(pendiente);
  assert.equal(fila[10], "gmail-message");
  assert.equal(fila[11], "true");
  assert.equal(fila[12], "gmail-thread");
  assert.equal(fila.length, 13);
  assert.deepEqual(
    deserializarFilaConciliacionAmbigua(fila.map(String)),
    pendiente
  );
});

test("una conciliación nueva de cola nunca se guarda con identidad parcial", async () => {
  const comun = {
    empresa: "Footprint" as const,
    gastoId: "gasto-identidad",
    descripcionGasto: "Gasto identidad",
    chatId: 42,
    candidatos: [],
    deColaCorreo: true,
    esAproximado: false,
    proveedor: "Proveedor",
    mensajeIdGmail: "gmail-message",
    comprobanteConfirmado: true,
  };
  await assert.rejects(
    guardarConciliacionAmbiguaPendiente(comun),
    /requiere mensajeIdGmail y threadIdGmail exactos/
  );
  await assert.rejects(
    guardarConciliacionPendiente({
      empresa: "Footprint",
      monto: 10,
      fecha: "2026-09-20",
      descripcionGasto: "Gasto identidad",
      chatId: 42,
      gastoId: "gasto-identidad",
      moneda: "EUR",
      proveedor: "Proveedor",
      deColaCorreo: true,
      mensajeIdGmail: "gmail-message",
      comprobanteConfirmado: true,
    }),
    /requiere mensajeIdGmail y threadIdGmail exactos/
  );
});

test("el consumo de una conciliación ambigua serializa lectura y borrado", async () => {
  const fuente = await readFile(
    join(process.cwd(), "core/gastos/conciliacionAmbiguaPendienteStore.ts"),
    "utf8"
  );
  const inicio = fuente.indexOf("export async function consumirConciliacionAmbiguaUnaVez");
  const fin = fuente.indexOf("export async function consumirConciliacionAmbiguaPendiente", inicio);
  const consumo = fuente.slice(inicio, fin);

  assert.match(consumo, /claveMutex = MUTEX_CONCILIACIONES_AMBIGUAS/);
  assert.match(consumo, /return conMutex\(claveMutex/);
  assert.ok(consumo.indexOf("leerVigentes()") < consumo.indexOf("eliminarFila("));
  assert.match(consumo, /if \(!fila\) return undefined/);
});

test("dos callbacks concurrentes consumen la misma conciliación una sola vez y conservan la fila vecina", async () => {
  const crear = (id: string): ConciliacionAmbiguaPendiente => ({
    id,
    empresa: "Footprint",
    gastoId: `gasto-${id}`,
    descripcionGasto: `Gasto ${id}`,
    chatId: 1,
    creadoEn: Date.now(),
    candidatos: [],
    esAproximado: false,
    comprobanteConfirmado: true,
  });
  const filas = [crear("conciliacion-a"), crear("conciliacion-b")];
  const dependencias: DependenciasConsumoConciliacionAmbigua = {
    leer: async () => filas.map((pendiente, indice) => ({ rowIndex: indice + 2, pendiente })),
    eliminar: async (rowIndex) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      filas.splice(rowIndex - 2, 1);
    },
  };

  const clave = `conciliacionAmbigua:test:${Date.now()}:${Math.random()}`;
  const resultados = await Promise.all([
    consumirConciliacionAmbiguaUnaVez("conciliacion-a", dependencias, clave),
    consumirConciliacionAmbiguaUnaVez("conciliacion-a", dependencias, clave),
  ]);

  assert.equal(resultados.filter(Boolean).length, 1);
  assert.deepEqual(filas.map((fila) => fila.id), ["conciliacion-b"]);
});

test("el flujo propaga threadId por creación, transición normal→ambigua y callbacks de cierre", async () => {
  const fuente = await readFile(join(process.cwd(), "core/gastos/gastoCallbackHandler.ts"), "utf8");
  assert.match(
    fuente,
    /guardarConciliacionAmbiguaPendiente\(\{[\s\S]*?mensajeIdGmail, comprobanteConfirmado, threadIdGmail \}\)/
  );
  assert.match(
    fuente,
    /pendiente\.mensajeIdGmail,\s*pendiente\.comprobanteConfirmado,\s*pendiente\.threadIdGmail/
  );

  const cierreAmbiguoInicio = fuente.indexOf('if (accion === "gasto_cerrar_ambigua")');
  const cierreAmbiguoFin = fuente.indexOf('if (accion === "gasto_espera")', cierreAmbiguoInicio);
  const cierreAmbiguo = fuente.slice(cierreAmbiguoInicio, cierreAmbiguoFin);
  assert.match(
    cierreAmbiguo,
    /\{ threadId: pendiente\.threadIdGmail, mensajeId: pendiente\.mensajeIdGmail \}/
  );

  const eleccionInicio = fuente.indexOf('if (accion === "gasto_conciliar_elegir"');
  const eleccionFin = fuente.indexOf('if (accion === "gasto_usarcontacto")', eleccionInicio);
  const eleccion = fuente.slice(eleccionInicio, eleccionFin);
  assert.equal(
    eleccion.match(/\{ threadId: pendiente\.threadIdGmail, mensajeId: pendiente\.mensajeIdGmail \}/g)?.length,
    2
  );
  assert.doesNotMatch(eleccion, /\{ mensajeId: pendiente\.mensajeIdGmail \}/);
});

test("la pregunta normal persiste threadId al final y conserva las columnas legacy", async () => {
  const fuente = await readFile(
    join(process.cwd(), "core/gastos/conciliacionPendienteStore.ts"),
    "utf8"
  );
  assert.match(fuente, /"comprobanteConfirmado",\s*"threadIdGmail"/);
  assert.match(fuente, /comprobanteConfirmado: row\[12\][\s\S]*threadIdGmail: row\[13\]/);
  assert.match(fuente, /pendiente\.comprobanteConfirmado \? "true" : "",\s*pendiente\.threadIdGmail \?\? ""/);
  assert.match(fuente, /restaurada\.comprobanteConfirmado \? "true" : "", restaurada\.threadIdGmail \?\? ""/);
  assert.match(fuente, /A2:N10000/);
});

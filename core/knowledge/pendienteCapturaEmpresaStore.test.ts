import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  consumirPendienteCapturaUnaVez,
  identidadCorreoDeCaptura,
  type DependenciasConsumoCapturaEmpresa,
  reclamarPendienteCapturaParaConfirmar,
  type DependenciasTransicionCapturaEmpresa,
  type PendienteCapturaEmpresa,
} from "./pendienteCapturaEmpresaStore";

test("la captura solo autoriza la identidad compuesta exacta", () => {
  assert.deepEqual(
    identidadCorreoDeCaptura({ threadId: "thread-captura", mensajeId: "message-captura" }),
    { threadId: "thread-captura", mensajeId: "message-captura" }
  );
  assert.equal(identidadCorreoDeCaptura({ threadId: undefined, mensajeId: " message-captura " }), undefined);
  assert.equal(identidadCorreoDeCaptura({ threadId: " thread-captura ", mensajeId: undefined }), undefined);
  assert.equal(identidadCorreoDeCaptura({ threadId: " ", mensajeId: "" }), undefined);
});

test("confirmar o cancelar una captura de correo avanza con identidad, nunca solo por chat", async () => {
  const fuente = await readFile(
    join(process.cwd(), "core/knowledge/capturaEmpresaCallbackHandler.ts"),
    "utf8"
  );
  const inicio = fuente.indexOf("async function avanzarCapturaDeCorreoSiCorresponde");
  const fin = fuente.indexOf("export async function iniciarSeleccionEmpresaCaptura", inicio);
  const avance = fuente.slice(inicio, fin);

  assert.match(avance, /identidadCorreoDeCaptura\(pendiente\)/);
  assert.match(avance, /if \(!identidad\)/);
  assert.match(avance, /avanzarColaCorreoSiActivo\([\s\S]*pendiente\.chatId,[\s\S]*identidad,[\s\S]*captura-cola/);
  assert.doesNotMatch(avance, /avanzarColaCorreoSiActivo\(pendiente\.chatId\)/);

  assert.match(fuente, /threadId:\s*identidadCorreo\?\.threadId/);
  assert.match(fuente, /mensajeId:\s*identidadCorreo\?\.mensajeId/);
});

test("confirmar reclama durablemente la captura antes de escribir y usa la clave estable", async () => {
  const fuenteHandler = await readFile(
    join(process.cwd(), "core/knowledge/capturaEmpresaCallbackHandler.ts"),
    "utf8"
  );
  const inicioConfirmar = fuenteHandler.indexOf('if (data === "capturaempresa_confirmar")');
  const finConfirmar = fuenteHandler.indexOf('if (data.startsWith("capturaempresa_toggle:"))', inicioConfirmar);
  const confirmar = fuenteHandler.slice(inicioConfirmar, finConfirmar);
  const indiceClaim = confirmar.indexOf("reclamarPendienteCapturaParaConfirmar(chatId, messageId)");
  const indiceEscritura = confirmar.indexOf("registrarCaptura(");

  assert.ok(indiceClaim >= 0 && indiceClaim < indiceEscritura, "el claim debe ocurrir antes del efecto externo");
  assert.match(confirmar, /restaurarPendienteCapturaEmpresa\(reclamada\)/);
  assert.match(confirmar, /reclamada\.idempotencyKey/);
  assert.match(confirmar, /marcarPendienteCapturaRegistrada\(reclamada\)/);

  const fuenteStore = await readFile(
    join(process.cwd(), "core/knowledge/pendienteCapturaEmpresaStore.ts"),
    "utf8"
  );
  const inicioConsumo = fuenteStore.indexOf("export async function consumirPendienteCapturaUnaVez");
  const finConsumo = fuenteStore.indexOf("export async function consumirPendienteCapturaEmpresa", inicioConsumo);
  const consumo = fuenteStore.slice(inicioConsumo, finConsumo);
  assert.match(consumo, /claveMutex = MUTEX_CAPTURAS/);
  assert.match(consumo, /conMutex\(claveMutex/);
});

test("dos confirmaciones concurrentes solo reclaman una y un claim abandonado se puede reanudar", async () => {
  const pendiente: PendienteCapturaEmpresa = {
    chatId: 77,
    messageId: 501,
    texto: "Conocimiento",
    empresasSeleccionadas: ["Footprint"],
    creadoEn: 1_000,
    actualizadoEn: 1_000,
    estado: "pendiente",
    idempotencyKey: "captura:77:501",
  };
  const filas = [pendiente];
  let ahora = 2_000;
  const dependencias: DependenciasTransicionCapturaEmpresa = {
    leer: async () => filas.map((valor, indice) => ({ rowIndex: indice + 2, pendiente: valor })),
    actualizar: async (rowIndex, valor) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      filas[rowIndex - 2] = valor;
    },
    ahora: () => ahora,
  };
  const mutex = `capturaClaim:test:${Date.now()}:${Math.random()}`;

  const resultados = await Promise.all([
    reclamarPendienteCapturaParaConfirmar(77, 501, dependencias, mutex),
    reclamarPendienteCapturaParaConfirmar(77, 501, dependencias, mutex),
  ]);
  assert.equal(resultados.filter((resultado) => resultado.estado === "reclamada").length, 1);
  assert.equal(resultados.filter((resultado) => resultado.estado === "en_proceso").length, 1);

  ahora += 3 * 60 * 1000;
  const reanudada = await reclamarPendienteCapturaParaConfirmar(77, 501, dependencias, mutex);
  assert.equal(reanudada.estado, "reclamada");
});

test("dos callbacks concurrentes reclaman la captura una sola vez y conservan la fila vecina", async () => {
  const crear = (messageId: number): PendienteCapturaEmpresa => ({
    chatId: 77,
    messageId,
    texto: `Captura ${messageId}`,
    empresasSeleccionadas: ["Footprint"],
    creadoEn: Date.now(),
  });
  const filas = [crear(101), crear(102)];
  const dependencias: DependenciasConsumoCapturaEmpresa = {
    leer: async () => filas.map((pendiente, indice) => ({ rowIndex: indice + 2, pendiente })),
    eliminar: async (rowIndex) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      filas.splice(rowIndex - 2, 1);
    },
  };

  const clave = `capturaEmpresa:test:${Date.now()}:${Math.random()}`;
  const resultados = await Promise.all([
    consumirPendienteCapturaUnaVez(77, 101, dependencias, clave),
    consumirPendienteCapturaUnaVez(77, 101, dependencias, clave),
  ]);

  assert.equal(resultados.filter(Boolean).length, 1);
  assert.deepEqual(filas.map((fila) => fila.messageId), [102]);
});

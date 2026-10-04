import test from "node:test";
import assert from "node:assert/strict";
import { solicitarActualizacion } from "./solicitarActualizacion";

test("la solicitud manual responde antes de terminar una lectura lenta", async () => {
  let terminar!: () => void;
  let empezo = false;
  const lectura = new Promise<void>((resolve) => { terminar = resolve; });
  const respuesta = solicitarActualizacion(() => { empezo = true; return lectura; }, () => assert.fail("No debía fallar"));
  assert.deepEqual(respuesta, { actualizacionSolicitada: true });
  await Promise.resolve();
  assert.equal(empezo, true);
  terminar();
  await lectura;
});

test("un fallo posterior se registra sin rechazar la respuesta ya enviada", async () => {
  const error = new Error("lectura fallida");
  let registrado: unknown;
  const respuesta = solicitarActualizacion(() => Promise.reject(error), (e) => { registrado = e; });
  assert.equal(respuesta.actualizacionSolicitada, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(registrado, error);
});

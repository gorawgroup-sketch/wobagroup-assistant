import { test } from "node:test";
import assert from "node:assert/strict";
import { LecturaFuentes } from "./lecturaFuentes";
import { crearAdaptadorSheetsConCuota, LimitadorVentana } from "../google/limitadorSheets";

test("fuente caída conserva su último valor y fecha, sin convertirlo en cero fresco", async () => {
  const reader = new LecturaFuentes();
  const first = await reader.ejecutar(() => reader.leer("correo", async () => 17, 0));
  const failed = await reader.ejecutar(() => reader.leer("correo", async () => { throw Error(); }, 0));
  assert.equal(failed.datos, 17);
  assert.equal(failed.fuentes[0].ok, false);
  assert.equal(failed.fuentes[0].conservado, true);
  assert.equal(failed.fuentes[0].ultimoExitoEn, first.fuentes[0].ultimoExitoEn);
  const recovered = await reader.ejecutar(() => reader.leer("correo", async () => 18, 0));
  assert.equal(recovered.fuentes[0].ok, true);
  assert.equal(recovered.datos, 18);
});

test("una fuente bloqueada queda marcada sin lectura válida y no bloquea todo el panel", async () => {
  const reader = new LecturaFuentes(10);
  const result = await reader.ejecutar(() => reader.leer("drive", () => new Promise(() => {}), []));
  assert.equal(result.fuentes[0].ok, false);
  assert.equal(result.fuentes[0].conservado, false);
  assert.equal(result.fuentes[0].ultimoExitoEn, null);
  assert.equal(result.fuentes[0].causa, "timeout");
});

test("una lectura con espera de cuota mayor al plazo ordinario conserva el resultado verificado", async () => {
  const reader = new LecturaFuentes(10);
  const result = await reader.ejecutar(() => reader.leer("sheets", async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return 23;
  }, 0, 50));
  assert.equal(result.datos, 23);
  assert.equal(result.fuentes[0].ok, true);
  assert.equal(result.fuentes[0].conservado, false);
});

test("el fallo conserva una causa segura para distinguir cuota y red", async () => {
  const reader = new LecturaFuentes();
  const cuota = await reader.ejecutar(() => reader.leer("hoja", async () => {
    throw { response: { status: 429 }, message: "dato sensible" };
  }, 0));
  assert.equal(cuota.fuentes[0].causa, "cuota");
  assert.equal(JSON.stringify(cuota.fuentes).includes("dato sensible"), false);
  const red = await reader.ejecutar(() => reader.leer("hoja", async () => {
    throw { code: "ETIMEDOUT" };
  }, 0));
  assert.equal(red.fuentes[0].causa, "transporte");
});

test("si vence una fuente, su petición Sheets no queda viva en la cola", async () => {
  const limitador = new LimitadorVentana(1, 0, 60_000);
  await limitador.adquirir("fondo");
  const adaptador = crearAdaptadorSheetsConCuota({ limitadores: { lectura: limitador, escritura: limitador } });
  let envios = 0;
  const reader = new LecturaFuentes(15);
  const resultado = await reader.ejecutar(() => reader.leer("hoja", () =>
    adaptador({ url: "https://sheets.googleapis.com/v4/spreadsheets/x/values/y" }, async () => {
      envios++;
      return { status: 200 };
    }), { status: 0 }));
  assert.equal(resultado.fuentes[0].causa, "timeout");
  assert.equal(limitador.estado.enCola, 0);
  assert.equal(limitador.estado.cancelaciones, 1);
  assert.equal(envios, 0);
});

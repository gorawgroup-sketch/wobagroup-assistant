import assert from "node:assert/strict";
import test from "node:test";
import { descargarFacturaEnlazada, DescargaFacturaEnlazadaError } from "./descargarFacturaEnlazada";

const pdfReal = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(100, 65)]);

function conFetch<T>(impl: typeof fetch, f: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return f().finally(() => { globalThis.fetch = original; });
}

test("descarga y devuelve los bytes cuando la firma del PDF es real", async () => {
  const bytes = await conFetch(
    async () => new Response(pdfReal, { status: 200, headers: { "content-type": "application/pdf" } }),
    () => descargarFacturaEnlazada("https://ejemplo.com/factura.pdf")
  );
  assert.equal(bytes.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.equal(bytes.length, pdfReal.length);
});

test("rechaza un 404/500 con un mensaje claro, no bytes vacíos disfrazados de éxito", async () => {
  await assert.rejects(
    conFetch(
      async () => new Response("no encontrado", { status: 404 }),
      () => descargarFacturaEnlazada("https://ejemplo.com/no-existe.pdf")
    ),
    DescargaFacturaEnlazadaError
  );
});

test("rechaza cuando el servidor miente en el content-type pero el archivo no es un PDF real", async () => {
  await assert.rejects(
    conFetch(
      async () => new Response("<html>esto no es un pdf</html>", { status: 200, headers: { "content-type": "application/pdf" } }),
      () => descargarFacturaEnlazada("https://ejemplo.com/factura.pdf")
    ),
    /firma de archivo inválida/
  );
});

test("rechaza un archivo que declara un tamaño mayor al límite seguro, sin llegar a descargarlo entero", async () => {
  await assert.rejects(
    conFetch(
      async () => new Response(pdfReal, { status: 200, headers: { "content-length": String(20 * 1024 * 1024) } }),
      () => descargarFacturaEnlazada("https://ejemplo.com/factura-enorme.pdf")
    ),
    /límite seguro/
  );
});

test("un fallo de red se reporta como DescargaFacturaEnlazadaError, no como una excepción genérica", async () => {
  await assert.rejects(
    conFetch(
      async () => { throw new Error("ECONNRESET"); },
      () => descargarFacturaEnlazada("https://ejemplo.com/factura.pdf")
    ),
    DescargaFacturaEnlazadaError
  );
});

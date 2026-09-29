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

// Hallazgo real de la revisión adversarial del PR #247: un 302 desde un dominio público hacia un host
// interno pasaba el chequeo del enlace original ("https" + termina en ".pdf") y llegaba igual.
test("nunca sigue una redirección — la pide como 'manual' y rechaza cualquier 3xx", async () => {
  let redirectPedido: string | undefined;
  await assert.rejects(
    conFetch(
      async (_url, init) => {
        redirectPedido = (init as RequestInit)?.redirect;
        return new Response(null, { status: 302, headers: { location: "https://interno.ejemplo/secreto.pdf" } });
      },
      () => descargarFacturaEnlazada("https://publico.ejemplo/factura.pdf")
    ),
    /redirige/
  );
  assert.equal(redirectPedido, "manual");
});

test("rechaza un 'opaqueredirect' (fetch real con redirect:manual lo reporta así) sin seguirlo", async () => {
  // El fetch real de Node/undici, con redirect:"manual", devuelve un objeto Response cuyo `type` es
  // "opaqueredirect" y `status` es 0 — un Response real no admite status:0 en su constructor, así que
  // se simula solo la forma que el código realmente lee (`type`/`status`/`ok`), no una Response real.
  const respuestaOpaca = { type: "opaqueredirect", status: 0, ok: false } as unknown as Response;
  await assert.rejects(
    conFetch(
      async () => respuestaOpaca,
      () => descargarFacturaEnlazada("https://publico.ejemplo/factura.pdf")
    ),
    /redirige/
  );
});

test("rechaza un host interno o una IP literal ANTES de intentar cualquier descarga", async () => {
  let seLlamoAFetch = false;
  const fetchQueNuncaDeberiaLlamarse: typeof fetch = async () => { seLlamoAFetch = true; return new Response(pdfReal); };
  for (const url of [
    "https://169.254.169.254/latest/meta-data/factura.pdf",
    "https://localhost/factura.pdf",
    "https://servicio.internal/factura.pdf",
    "https://backend.local/factura.pdf",
    "https://[::1]/factura.pdf",
  ]) {
    await assert.rejects(conFetch(fetchQueNuncaDeberiaLlamarse, () => descargarFacturaEnlazada(url)), DescargaFacturaEnlazadaError, url);
  }
  assert.equal(seLlamoAFetch, false, "ningún host interno debe llegar a disparar la petición real");
});

test("un dominio público normal sí se descarga sin problema", async () => {
  const bytes = await conFetch(
    async () => new Response(pdfReal, { status: 200 }),
    () => descargarFacturaEnlazada("https://queenhomeapartmentssrls.italianway.house/orders/x/invoice/1.pdf")
  );
  assert.equal(bytes.length, pdfReal.length);
});

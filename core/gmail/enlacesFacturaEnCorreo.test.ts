import assert from "node:assert/strict";
import test from "node:test";
import { extraerEnlacesPdf } from "./enlacesFacturaEnCorreo";

test("reconoce enlaces https que terminan en .pdf y conserva el texto visible", () => {
  const html = `
    <p>please find attached the documents for your stay.</p>
    <p>ATTACHMENTS</p>
    <a href="https://queenhomeapartmentssrls.italianway.house/orders/x/invoice/1869521.pdf">invoice_2026000097-rk_1869521.pdf</a>
    <a href="https://queenhomeapartmentssrls.italianway.house/orders/x/invoice/1869522.pdf">invoice_2026001038-fk_1869522.pdf</a>
    <a href="https://queenhomeapartmentssrls.italianway.house/orders/x/invoice/1869523.pdf">invoice_2026000098-rk_1869523.pdf</a>
  `;
  const enlaces = extraerEnlacesPdf(html);
  assert.equal(enlaces.length, 3);
  assert.equal(enlaces[0].url, "https://queenhomeapartmentssrls.italianway.house/orders/x/invoice/1869521.pdf");
  assert.equal(enlaces[0].texto, "invoice_2026000097-rk_1869521.pdf");
});

test("ignora enlaces sin .pdf, http sin cifrar, o repetidos", () => {
  const html = `
    <a href="https://ejemplo.com/reserva">Ver reserva</a>
    <a href="http://ejemplo.com/factura.pdf">Sin cifrar, se ignora</a>
    <a href="https://ejemplo.com/factura.pdf">Factura</a>
    <a href="https://ejemplo.com/factura.pdf">Repetida</a>
    <a href="https://ejemplo.com/factura.pdf?token=abc">Con parámetros, distinta URL</a>
  `;
  const enlaces = extraerEnlacesPdf(html);
  assert.deepEqual(enlaces.map(e => e.url), [
    "https://ejemplo.com/factura.pdf",
    "https://ejemplo.com/factura.pdf?token=abc",
  ]);
});

test("un cuerpo sin HTML (o vacío) no produce ningún enlace", () => {
  assert.deepEqual(extraerEnlacesPdf(""), []);
  assert.deepEqual(extraerEnlacesPdf(undefined as unknown as string), []);
  assert.deepEqual(extraerEnlacesPdf("<p>Solo texto, sin enlaces.</p>"), []);
});

test("nunca reporta más del límite de enlaces a intentar", () => {
  const html = Array.from({ length: 10 }, (_, i) => `<a href="https://ejemplo.com/f${i}.pdf">f${i}</a>`).join("\n");
  const enlaces = extraerEnlacesPdf(html);
  assert.ok(enlaces.length <= 6, `esperaba como mucho 6, salieron ${enlaces.length}`);
});

import assert from "node:assert/strict";
import test from "node:test";
import { incrustarRecursosInlineCorreo } from "./client";
import { configuracionComprobanteVisual, prepararHtmlCorreoParaPDF } from "./generarComprobantePDF";

test("el render visual está activo por defecto y solo false lo desactiva", () => {
  assert.equal(configuracionComprobanteVisual({} as NodeJS.ProcessEnv).habilitado, true);
  assert.equal(
    configuracionComprobanteVisual({ WOBI_EMAIL_VISUAL_PDF_ENABLED: " false " } as NodeJS.ProcessEnv).habilitado,
    false
  );
  assert.equal(
    configuracionComprobanteVisual({ WOBI_EMAIL_VISUAL_PDF_ENABLED: "0" } as NodeJS.ProcessEnv).habilitado,
    true
  );
});

test("conserva el diseño pasivo y elimina scripts, navegación y recursos remotos", () => {
  const html = prepararHtmlCorreoParaPDF({
    de: 'Proveedor <facturas@example.com><script>alert("header")</script>',
    asunto: "Resumen & viaje",
    fecha: "11 sep 2026",
    cuerpoCompleto: "respaldo",
    htmlOriginal: `<!doctype html><html><head><style>.total{color:#080}</style></head>
      <body onload="robar()"><script>robar()</script><iframe src="https://evil.example"></iframe>
      <table style="background:#000;color:#fff"><tr><td class="total">20,96 EUR</td></tr></table>
      <img src="data:image/png;base64,YQ==" onerror="robar()"><img src="http://127.0.0.1/secreto">
      <a href="https://tracker.example">Ayuda</a></body></html>`,
  });

  assert.match(html, /background:#000/);
  assert.match(html, /\[style\*="background:#000"\] \*/);
  assert.match(html, /20,96 EUR/);
  assert.match(html, /data:image\/png;base64,YQ==/);
  assert.match(html, /Correo original/);
  assert.match(html, /Resumen &amp; viaje/);
  assert.match(html, /&lt;script&gt;alert/);
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /<iframe\b/i);
  assert.doesNotMatch(html, /onload=|onerror=/i);
  assert.doesNotMatch(html, /href=/i);
  assert.doesNotMatch(html, /127\.0\.0\.1/);
});

test("incrusta imágenes cid y Content-Location con los bytes reales del correo", () => {
  const resultado = incrustarRecursosInlineCorreo(
    '<img src="cid:logo.1"><img src="https://assets.example/receipt.png">',
    [
      { referencias: ["<logo.1>"], mimeType: "image/png", bytes: Buffer.from("logo") },
      { referencias: ["https://assets.example/receipt.png"], mimeType: "image/jpeg", bytes: Buffer.from("receipt") },
      { referencias: ["<ignorar>"], mimeType: "text/html", bytes: Buffer.from("no") },
    ]
  );
  assert.match(resultado, /data:image\/png;base64,bG9nbw==/);
  assert.match(resultado, /data:image\/jpeg;base64,cmVjZWlwdA==/);
  assert.doesNotMatch(resultado, /cid:logo\.1|https:\/\/assets\.example/);
});

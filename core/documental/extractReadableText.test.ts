import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { extraerTextoDeterminista } from "./extractReadableText";

test("lee texto y HTML sin invocar IA", async () => {
  assert.equal(
    await extraerTextoDeterminista(Buffer.from("hola\nElsamex"), "text/plain", "nota.txt"),
    "hola\nElsamex"
  );
  assert.equal(
    await extraerTextoDeterminista(Buffer.from("<h1>Responsabilidades</h1><p>Enviar a Marisol</p>"), "text/html", "nota.html"),
    "Responsabilidades\nEnviar a Marisol"
  );
});

test("lee Google Docs exportados como texto plano", async () => {
  const contenido = Buffer.from("Facturación mensual de Elsamex a marisol@elsamex.com");
  assert.equal(
    await extraerTextoDeterminista(contenido, "text/plain", "RESUMEN RESPONSABILIDADES.txt"),
    contenido.toString("utf8")
  );
});

test("extrae texto de Word y PowerPoint modernos", async () => {
  const docx = new JSZip();
  docx.file("word/document.xml", "<w:document><w:p><w:r><w:t>Factura Elsamex</w:t></w:r></w:p></w:document>");
  const docxBytes = await docx.generateAsync({ type: "nodebuffer" });
  assert.equal(
    await extraerTextoDeterminista(docxBytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "responsabilidades.docx"),
    "Factura Elsamex"
  );

  const pptx = new JSZip();
  pptx.file("ppt/slides/slide1.xml", "<p:sld><a:p><a:r><a:t>Dirección de envío</a:t></a:r></a:p></p:sld>");
  const pptxBytes = await pptx.generateAsync({ type: "nodebuffer" });
  assert.equal(
    await extraerTextoDeterminista(pptxBytes, "application/vnd.openxmlformats-officedocument.presentationml.presentation", "guia.pptx"),
    "Dirección de envío"
  );
});

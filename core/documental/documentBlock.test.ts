import assert from "node:assert/strict";
import test from "node:test";
import { mimeADocumentBlock } from "./documentBlock";

test("reconoce un PDF real que Gmail entrega como application/octet-stream", async () => {
  const data = Buffer.from("%PDF-1.7\ncontenido de prueba");
  const bloque = await mimeADocumentBlock("Receipt-XJVNRW.pdf", "application/octet-stream", data);
  assert.equal(bloque.type, "document");
  if (bloque.type === "document") assert.equal(bloque.source.media_type, "application/pdf");
});

test("una extensión PDF sin firma binaria continúa bloqueada", async () => {
  await assert.rejects(
    () => mimeADocumentBlock("archivo.pdf", "application/octet-stream", Buffer.from("no es un pdf")),
    /Tipo de archivo no soportado/
  );
});

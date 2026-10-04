import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { prepararBloquesDocumento } from "./documentBlock";
import { esDocumentoLegible, mimeDeLectura } from "./readableFormats";
import { convertirHeicAJpeg } from "./convertHeic";

test("HEIC/HEIF llega al lector por MIME normalizado o nombre de adjunto genérico", () => {
  for (const mime of ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence", " IMAGE/HEIC; charset=binary "]) {
    assert.equal(esDocumentoLegible(mime, "adjunto.bin"), true);
  }
  assert.equal(esDocumentoLegible("application/octet-stream", "FACTURA.HEIC"), true);
  assert.equal(esDocumentoLegible(undefined, "factura.heif"), true);
  assert.equal(esDocumentoLegible("application/zip", "factura.heic"), false);
  assert.equal(mimeDeLectura("application/pdf", "factura.heic"), "application/pdf");
});

test("una conversión HEIC real produce JPEG legible y no modifica los bytes originales", async () => {
  const path = join(__dirname, "fixtures", "sample.heic");
  const original = await readFile(path);
  const copy = Buffer.from(original);
  const blocks = await prepararBloquesDocumento("descarga.bin", "application/octet-stream", original, "FACTURA.HEIC");
  assert.equal(blocks.length, 1);
  const block = blocks[0];
  if (block.type === "text") throw new Error("Se esperaba una imagen");
  assert.equal(block.type, "image");
  assert.equal(block.source.media_type, "image/jpeg");
  const jpeg = Buffer.from(block.source.data, "base64");
  assert.deepEqual([...jpeg.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  // Decode the resulting JPEG too: a renamed file or invalid payload cannot pass.
  const decoder = require("jpeg-js") as { decode(data: Buffer): { width: number; height: number; data: Uint8Array } };
  const decoded = decoder.decode(jpeg);
  assert.equal(decoded.width, 256);
  assert.equal(decoded.height, 256);
  assert.ok(decoded.data[0] > 200);
  assert.ok(decoded.data[(255 * 256) * 4] < 50);
  assert.deepEqual(original, copy);
  assert.deepEqual(await readFile(path), copy);
});

test("un HEIF con MIME explícito usa la misma conversión", async () => {
  const bytes = await readFile(join(__dirname, "fixtures", "sample.heic"));
  const blocks = await prepararBloquesDocumento("adjunto.bin", "image/heif", bytes);
  assert.equal(blocks[0].type, "image");
});

test("HEIC dañado o vacío informa del error en lugar de devolver un falso documento no contable", async () => {
  await assert.rejects(prepararBloquesDocumento("factura.heic", "image/heic", Buffer.from("not an image")), /convertir|conversión/i);
  await assert.rejects(convertirHeicAJpeg(Buffer.alloc(0)), /vacío/);
  await assert.rejects(convertirHeicAJpeg(Buffer.alloc(20 * 1024 * 1024 + 1)), /20 MB/);
});

test("PDF, JPEG y texto conservan su contenido y tipo sin conversión HEIC", async () => {
  for (const [mime, type] of [["application/pdf", "document"], ["image/jpeg", "image"], ["image/png", "image"], ["image/webp", "image"], ["image/gif", "image"]]) {
    const bytes = Buffer.from("unchanged fixture payload");
    const [block] = await prepararBloquesDocumento("archivo", mime, bytes);
    assert.equal(block.type, type);
    if (block.type === "text") throw new Error("Tipo inesperado");
    assert.equal(block.source.media_type, mime);
    assert.deepEqual(Buffer.from(block.source.data, "base64"), bytes);
  }
  assert.deepEqual(await prepararBloquesDocumento("nota.md", "text/markdown", Buffer.from("Una nota")), [{ type: "text", text: "Una nota" }]);
  await assert.rejects(prepararBloquesDocumento("archivo.zip", "application/zip", Buffer.from("zip")), /no soportado/);
});

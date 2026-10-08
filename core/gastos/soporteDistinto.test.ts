import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { debeOfrecerSoporteDistinto } from "./soporteDistinto";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const pdfNuevo = Buffer.from("%PDF-1.7 nuevo");
const pdfOtro = Buffer.from("%PDF-1.4 otro");
const huella = (b: Buffer) => createHash("sha256").update(b).digest("hex");

test("el gasto solo tiene imágenes y llega un PDF distinto: se ofrece adjuntarlo (caso Antaris)", () => {
  assert.equal(debeOfrecerSoporteDistinto({ huellaContenido: huella(pdfNuevo), mimeTypeNuevo: "application/pdf", adjuntosDelGasto: [{ bytes: png }] }), true);
});

test("el mismo archivo ya adjunto: se bloquea como siempre", () => {
  assert.equal(debeOfrecerSoporteDistinto({ huellaContenido: huella(pdfNuevo), mimeTypeNuevo: "application/pdf", adjuntosDelGasto: [{ bytes: png }, { bytes: pdfNuevo }] }), false);
});

test("el gasto ya tiene un PDF distinto: no se ofrece (puede ser otra versión del mismo documento)", () => {
  assert.equal(debeOfrecerSoporteDistinto({ huellaContenido: huella(pdfNuevo), mimeTypeNuevo: "application/pdf", adjuntosDelGasto: [{ bytes: pdfOtro }] }), false);
});

test("una imagen nueva sobre un gasto que solo tiene imágenes: no se ofrece", () => {
  assert.equal(debeOfrecerSoporteDistinto({ huellaContenido: huella(Buffer.from("otra imagen")), mimeTypeNuevo: "image/png", adjuntosDelGasto: [{ bytes: png }] }), false);
});

test("el gasto sin ningún adjunto: se ofrece adjuntar el archivo", () => {
  assert.equal(debeOfrecerSoporteDistinto({ huellaContenido: huella(png), mimeTypeNuevo: "image/png", adjuntosDelGasto: [] }), true);
});

test("sin huella del archivo nuevo no se decide nada", () => {
  assert.equal(debeOfrecerSoporteDistinto({ mimeTypeNuevo: "application/pdf", adjuntosDelGasto: [] }), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { deduplicarYAcotar, huellaDeParte, MAX_ADJUNTOS_A_LEER, mensajeDeExceso } from "./proteccionAdjuntos";
import { extraerAdjuntosProtegidos } from "../../gmail/client";

const pdf = (n: number) => ({ filename: `factura-${n}.pdf`, mimeType: "application/pdf", size: 50_000 + n });

test("repetidos (mismo tipo, nombre y tamaño) se leen una sola vez; sin tamaño conocido no se deduplica", () => {
  const partes = [pdf(1), pdf(1), pdf(1), pdf(2), { filename: "x.png", mimeType: "image/png", size: null }, { filename: "x.png", mimeType: "image/png", size: null }];
  const r = deduplicarYAcotar(partes);
  assert.equal(r.aLeer.length, 4);
  assert.equal(r.repetidas, 2);
  assert.equal(r.exceso, 0);
});

test("el tope por correo corta el exceso y lo cuenta, conservando el orden", () => {
  const muchos = Array.from({ length: 30 }, (_, i) => pdf(i));
  const r = deduplicarYAcotar(muchos);
  assert.equal(r.aLeer.length, MAX_ADJUNTOS_A_LEER);
  assert.equal(r.exceso, 30 - MAX_ADJUNTOS_A_LEER);
  assert.equal(r.aLeer[0].filename, "factura-0.pdf");
});

test("huella: no distingue mayúsculas ni espacios del nombre", () => {
  assert.equal(huellaDeParte({ filename: " Logo.PNG ", mimeType: "IMAGE/png", size: 5 }), huellaDeParte({ filename: "logo.png", mimeType: "image/png", size: 5 }));
});

test("el aviso de exceso dice cuántos no se leen y cómo pedirlos", () => {
  assert.match(mensajeDeExceso(5), /5 adjunto\(s\) más/);
  assert.match(mensajeDeExceso(5), /solo el adjunto/);
});

test("caso real 07-10: 58 imágenes «noname» incrustadas + 1 recibo → solo se lee el recibo", () => {
  const cabeceras = (disp: string) => [{ name: "Content-Disposition", value: disp }, { name: "Content-ID", value: "<c>" }];
  const decorativas = Array.from({ length: 58 }, (_, i) => ({ partId: `d${i}`, filename: "noname", mimeType: "image/png", body: { attachmentId: `a${i}`, size: 500 + (i % 6) }, headers: cabeceras(i < 12 ? "inline" : "attachment") }));
  const recibo = { partId: "r", filename: "Receipt.pdf", mimeType: "application/pdf", body: { attachmentId: "ra", size: 34_000 }, headers: [] };
  const r = extraerAdjuntosProtegidos({ mimeType: "multipart/mixed", parts: [...decorativas, recibo] } as never);
  assert.deepEqual(r.adjuntos.map((a) => a.filename), ["Receipt.pdf"]);
  assert.equal(r.omitidos.decorativas, 58);
  assert.equal(r.omitidos.exceso, 0);
});

test("un correo con 30 facturas distintas lee las 12 primeras y avisa de 18", () => {
  const partes = Array.from({ length: 30 }, (_, i) => ({ partId: String(i), filename: `f${i}.pdf`, mimeType: "application/pdf", body: { attachmentId: `a${i}`, size: 10_000 + i }, headers: [] }));
  const r = extraerAdjuntosProtegidos({ mimeType: "multipart/mixed", parts: partes } as never);
  assert.equal(r.adjuntos.length, MAX_ADJUNTOS_A_LEER);
  assert.equal(r.omitidos.exceso, 18);
});

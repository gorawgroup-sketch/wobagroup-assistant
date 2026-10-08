import assert from "node:assert/strict";
import test from "node:test";
import { extraerAdjuntos } from "../../gmail/client";
import { esImagenIncrustadaDeRelleno, TAMANIO_MAXIMO_IMAGEN_INCRUSTADA } from "./decoracion";

const parte = (o: { id: string; mime?: string; nombre?: string; tam?: number | null; disp?: string; cid?: boolean }) => ({
  partId: o.id, filename: o.nombre ?? "noname", mimeType: o.mime ?? "image/png",
  headers: [{ name: "Content-Disposition", value: `${o.disp ?? "attachment"}; filename=${o.nombre ?? "noname"}` }, ...(o.cid === false ? [] : [{ name: "Content-ID", value: `<${o.id}@x>` }])],
  body: { attachmentId: `att-${o.id}`, ...(o.tam === null ? {} : { size: o.tam ?? 1000 }) },
});

test("el caso real de Booking.com (07-10): 58 imágenes «noname» con Content-ID, inline y attachment, no son adjuntos", () => {
  const tamanos = [7827, 1097, 410, 348, 13797, 17591, 978, 705, 3014, 409, 1271, 1992];
  const inline = tamanos.map((t, i) => parte({ id: `0.${i + 1}`, tam: t, disp: "inline" }));
  const comoAdjunto = Array.from({ length: 46 }, (_, i) => parte({ id: String(i + 1), tam: [1541, 426, 622, 270, 680, 1097, 705][i % 7], disp: "attachment" }));
  const payload = { partId: "", mimeType: "multipart/mixed", parts: [...inline, ...comoAdjunto] };
  assert.equal(extraerAdjuntos(payload as never).length, 0);
});

test("lo que NO es relleno sigue siendo adjunto: PDF con Content-ID, imagen con nombre real, imagen grande, sin Content-ID o sin tamaño", () => {
  const casos = [
    parte({ id: "a", mime: "application/pdf", nombre: "Receipt.pdf", tam: 276_540 }),      // el PDF de Alejandro (attachment + Content-ID)
    parte({ id: "b", mime: "application/pdf", nombre: "noname", tam: 800 }),               // un documento nunca es decoración
    parte({ id: "c", nombre: "HOTEL.png", tam: 5_000 }),                                    // imagen pequeña pero con nombre real
    parte({ id: "d", tam: TAMANIO_MAXIMO_IMAGEN_INCRUSTADA + 1 }),                          // «noname» grande: puede ser un recibo pegado
    parte({ id: "e", tam: 900, cid: false }),                                               // sin Content-ID: no está incrustada en ningún sitio
    parte({ id: "f", tam: null }),                                                          // tamaño desconocido: nunca decorativa
  ];
  const adjuntos = extraerAdjuntos({ partId: "", mimeType: "multipart/mixed", parts: casos } as never);
  assert.deepEqual(adjuntos.map((a) => a.partId).sort(), ["a", "b", "c", "d", "e", "f"]);
});

test("un recibo real convive con la decoración: solo queda el recibo", () => {
  const payload = { partId: "", mimeType: "multipart/mixed", parts: [parte({ id: "1", tam: 1541 }), parte({ id: "2", mime: "application/pdf", nombre: "Factura 123.pdf", tam: 80_000 }), parte({ id: "3", mime: "image/gif", tam: 1097, disp: "inline" })] };
  assert.deepEqual(extraerAdjuntos(payload as never).map((a) => a.filename), ["Factura 123.pdf"]);
});

test("la regla en sí: límites exactos", () => {
  assert.equal(esImagenIncrustadaDeRelleno(parte({ id: "x", tam: TAMANIO_MAXIMO_IMAGEN_INCRUSTADA })), true);
  assert.equal(esImagenIncrustadaDeRelleno(parte({ id: "x", tam: TAMANIO_MAXIMO_IMAGEN_INCRUSTADA + 1 })), false);
  assert.equal(esImagenIncrustadaDeRelleno({ mimeType: "image/png", filename: "", headers: [{ name: "Content-ID", value: "<a>" }], body: { size: 100 } }), true, "sin nombre también es relleno");
  assert.equal(esImagenIncrustadaDeRelleno({ mimeType: "IMAGE/GIF", filename: "NoName", headers: [{ name: "content-id", value: "<a>" }], body: { size: 100 } }), true);
});

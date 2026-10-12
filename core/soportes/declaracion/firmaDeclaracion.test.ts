import assert from "node:assert/strict";
import test from "node:test";
import { declaracionesConRecordatorioVencido, elegirAdjuntoFirma, esAdjuntoCandidatoFirma, nombreArchivoFirmado, textoRecordatorio } from "./firmaDeclaracion";
import type { Declaracion } from "./declaracionStore";

const DIA = 86_400_000;
const decl = (extra: Partial<Declaracion>): Declaracion => ({ id: "d1", empresa: "EWORKS", titular: "German Alejandro Robles", email: "project@wobagroup.com", cargoFirmante: "CEO",
  chatId: 1, cargos: [{ id: "1", fecha: "2026-09-07", lugar: "Airalo", valor: 9, moneda: "EUR" }], driveFileId: "f", driveUrl: "u",
  nombreArchivo: "GASTOS SIN SOPORTE GERMAN ALEJANDRO ROBLES 2026-10-12.docx", estado: "enviada", creadoEn: 0, enviadoEn: 0, ...extra });

test("solo un PDF o una imagen con tamaño de documento es candidato a firma; el PDF manda sobre la imagen", () => {
  assert.equal(esAdjuntoCandidatoFirma({ filename: "firma.png", mimeType: "image/png", size: 2_000 }), false); // icono de firma de correo
  assert.equal(esAdjuntoCandidatoFirma({ filename: "declaracion.pdf", mimeType: "application/pdf", size: 120_000 }), true);
  assert.equal(esAdjuntoCandidatoFirma({ filename: "foto.jpg", mimeType: "application/octet-stream", size: 900_000 }), true);
  assert.equal(esAdjuntoCandidatoFirma({ filename: "datos.xlsx", mimeType: "application/vnd.ms-excel", size: 900_000 }), false);
  const elegido = elegirAdjuntoFirma([
    { filename: "foto.jpg", mimeType: "image/jpeg", size: 2_000_000, attachmentId: "a", partId: "1" },
    { filename: "declaracion firmada.pdf", mimeType: "application/pdf", size: 150_000, attachmentId: "b", partId: "2" },
  ]);
  assert.equal(elegido?.filename, "declaracion firmada.pdf");
});

test("el archivo firmado se guarda con el nombre de la original más FIRMADO y la extensión del adjunto", () => {
  assert.equal(nombreArchivoFirmado(decl({}), "scan.PDF"), "GASTOS SIN SOPORTE GERMAN ALEJANDRO ROBLES 2026-10-12 FIRMADO.pdf");
  assert.equal(nombreArchivoFirmado(decl({}), "IMG_0012.jpg"), "GASTOS SIN SOPORTE GERMAN ALEJANDRO ROBLES 2026-10-12 FIRMADO.jpg");
});

test("recordatorio solo a las enviadas hace ≥ N días, sin recordatorio reciente y sin firma candidata pendiente", () => {
  const ahora = 100 * DIA;
  const lista = [
    decl({ id: "vieja", enviadoEn: ahora - 6 * DIA }),
    decl({ id: "reciente", enviadoEn: ahora - 2 * DIA }),
    decl({ id: "ya-recordada", enviadoEn: ahora - 20 * DIA, recordatorioEn: ahora - 1 * DIA }),
    decl({ id: "recordar-otra-vez", enviadoEn: ahora - 20 * DIA, recordatorioEn: ahora - 7 * DIA }),
    decl({ id: "con-candidata", enviadoEn: ahora - 9 * DIA, firmaCandidata: { mensajeId: "m", filename: "x.pdf", mimeType: "application/pdf", size: 1, recibidaEn: 1 } }),
    decl({ id: "firmada", enviadoEn: ahora - 9 * DIA, estado: "firmada" }),
  ];
  assert.deepEqual(declaracionesConRecordatorioVencido(lista, ahora, 5).map((d) => d.id), ["vieja", "recordar-otra-vez"]);
  assert.match(textoRecordatorio(lista[0]), /^Hola German,[\s\S]*respondiendo a este correo/);
});

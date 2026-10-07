import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { extraerTextoDeterminista } from "../../documental/extractReadableText";
import type { AdjuntoCorreo } from "../../gmail/client";
import { leerAdjuntosParaClasificador, MAX_CARACTERES_ADJUNTO, MAX_CARACTERES_TOTAL, seccionAdjuntos, type DependenciasAdjuntos } from "./adjuntos";
import { accionGlobal, listaDePeticiones, MAX_PETICIONES, normalizarPeticiones } from "./peticiones";

test("las peticiones del modelo se validan: sin «qué» o sin acción se descartan, el resto se limpia y se limita", () => {
  const p = normalizarPeticiones([
    { quien: "Noelia Casas (Cratevo)", que: "Elegir nivel de servicio  (One, Pro o Platinum)", accion: "Responder indicando el nivel", fecha_limite: "15/10/2026" },
    { quien: "Banco", que: "", accion: "x" },
    { quien: "Alejandro", que: "Enviar el recibo", accion: "" },
    { que: "Revisar la hoja", accion: "Abrirla", sobre_adjunto: "Seguimiento.xlsx" },
    "basura", null,
  ]);
  assert.equal(p.length, 2);
  assert.equal(p[0].que, "Elegir nivel de servicio (One, Pro o Platinum)");
  assert.equal(p[0].fechaLimite, "15/10/2026");
  assert.equal(p[1].quien, "(no se indica)");
  assert.equal(p[1].sobreAdjunto, "Seguimiento.xlsx");
  assert.deepEqual(normalizarPeticiones(undefined), []);
  assert.equal(normalizarPeticiones(Array.from({ length: 20 }, () => ({ que: "a", accion: "b" }))).length, MAX_PETICIONES);
});

test("con varias peticiones el mensaje lleva una lista numerada con una acción cada una; con una sola no añade nada", () => {
  const p = normalizarPeticiones([
    { quien: "Alejandro", que: "Aclara que no reconoce el cargo Dlo*uber de 1,25 €", accion: "Mantenerlo pendiente e investigar" },
    { quien: "Alejandro", que: "Reenvía el recibo de Uber", accion: "Pedirle el recibo del 23/09", sobre_adjunto: "Receipt.pdf", fecha_limite: "esta semana" },
  ]);
  const lista = listaDePeticiones(p);
  assert.match(lista, /^Peticiones detectadas:\n1\. Alejandro pide: Aclara que no reconoce el cargo Dlo\*uber de 1,25 €\n   ✅ Acción propuesta: Mantenerlo pendiente/);
  assert.match(lista, /2\. Alejandro pide: Reenvía el recibo de Uber \(sobre «Receipt\.pdf»\) — plazo: esta semana\n   ✅ Acción propuesta: Pedirle el recibo del 23\/09/);
  assert.match(accionGlobal(p, "genérica"), /^Atender las 2 peticiones: 1\) Mantenerlo pendiente e investigar; 2\) Pedirle el recibo del 23\/09\.$/);
  assert.equal(listaDePeticiones(p.slice(0, 1)), "");
  assert.equal(accionGlobal(p.slice(0, 1), "la del modelo"), "la del modelo");
  assert.equal(accionGlobal([], "la del modelo"), "la del modelo");
});

const adj = (filename: string, mimeType: string, size = 1000): AdjuntoCorreo => ({ filename, mimeType, attachmentId: filename, size, partId: filename } as AdjuntoCorreo);
const depsConTexto = (mapa: Record<string, string | undefined>): DependenciasAdjuntos => ({
  descargar: async (_id, a) => Buffer.from(a.filename),
  extraer: async (bytes) => mapa[bytes.toString()],
});

test("los adjuntos de texto se leen sin IA y los PDF/imágenes se declaran no leídos en este paso", async () => {
  const l = await leerAdjuntosParaClasificador("c1", [adj("obs.csv", "text/csv"), adj("carta.pdf", "application/pdf"), adj("foto.png", "image/png"), adj("raro.bin", "application/octet-stream")], depsConTexto({ "obs.csv": "cargo;comentario\n1;no lo reconozco", "raro.bin": undefined }));
  assert.deepEqual(l.map((x) => [x.nombre, x.estado]), [["obs.csv", "leido"], ["carta.pdf", "no_leido"], ["foto.png", "no_leido"], ["raro.bin", "no_leido"]]);
  const sec = seccionAdjuntos(l);
  assert.match(sec, /«obs\.csv» — leído:\ncargo;comentario\n1;no lo reconozco/);
  assert.match(sec, /«carta\.pdf» — NO leído en este paso: PDF o imagen/);
  assert.match(sec, /«raro\.bin» — NO leído en este paso: formato sin texto legible sin IA/);
  assert.match(sec, /no concluyas nada sobre los que figuran como no leídos/);
  assert.equal(seccionAdjuntos([]), "");
});

test("límites: texto largo se recorta y lo dice, el total se acota y los adjuntos de más o demasiado grandes no se leen", async () => {
  const largo = "x".repeat(MAX_CARACTERES_ADJUNTO + 500);
  const l = await leerAdjuntosParaClasificador("c1", [adj("a.txt", "text/plain"), adj("b.txt", "text/plain"), adj("c.txt", "text/plain"), adj("d.txt", "text/plain"), adj("grande.txt", "text/plain", 50_000_000)], depsConTexto({ "a.txt": largo, "b.txt": largo, "c.txt": largo, "d.txt": largo }));
  assert.equal(l[0].truncado, true);
  assert.equal(l[0].texto!.length, MAX_CARACTERES_ADJUNTO);
  assert.ok(l.filter((x) => x.estado === "leido").reduce((s, x) => s + x.texto!.length, 0) <= MAX_CARACTERES_TOTAL);
  assert.equal(l[3].estado, "no_leido", "agotado el total de texto");
  assert.match(l[4].motivo!, /tamaño máximo/);
  const muchos = await leerAdjuntosParaClasificador("c1", Array.from({ length: 8 }, (_, i) => adj(`f${i}.txt`, "text/plain")), depsConTexto(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}.txt`, "hola"]))));
  assert.match(muchos[7].motivo!, /primeros 6 adjuntos/);
});

test("un fallo al descargar un adjunto no tumba la lectura de los demás", async () => {
  const silenciar = console.error; console.error = () => undefined;
  try {
    const deps: DependenciasAdjuntos = { descargar: async (_i, a) => { if (a.filename === "roto.txt") throw new Error("403"); return Buffer.from("ok"); }, extraer: async () => "texto" };
    const l = await leerAdjuntosParaClasificador("c1", [adj("roto.txt", "text/plain"), adj("bien.txt", "text/plain")], deps);
    assert.deepEqual(l.map((x) => x.estado), ["no_leido", "leido"]);
  } finally { console.error = silenciar; }
});

test("un Excel real (hoja de seguimiento con estados) se lee con el extractor determinista", async () => {
  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet("Soportes");
  hoja.addRow(["Nº", "Comercio", "Estado del soporte", "Comentarios"]);
  hoja.addRow([1, "Rappi* Verif", "No lo reconozco", "El reembolso se hizo el 4/09"]);
  const bytes = Buffer.from(await libro.xlsx.writeBuffer());
  const texto = await extraerTextoDeterminista(bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Seguimiento.xlsx");
  assert.match(texto ?? "", /No lo reconozco/);
  assert.match(texto ?? "", /El reembolso se hizo el 4\/09/);
});

import { lecturaVisualActiva, MAX_LECTURAS_VISUALES, MIN_BYTES_IMAGEN } from "./adjuntos";

const visual = (resultados: Record<string, { esGasto: boolean; resumen?: string; texto?: string } | "error">, llamadas: string[] = []): DependenciasAdjuntos => ({
  descargar: async (_i, a) => Buffer.from(a.filename),
  extraer: async () => undefined,
  leerVisual: async (bytes) => {
    const nombre = bytes.toString(); llamadas.push(nombre);
    const r = resultados[nombre]; if (r === "error") throw new Error("visión caída");
    return r ?? { esGasto: false, texto: "" };
  },
});

test("PDF/imagen: una factura entra como resumen de una línea y una carta se transcribe, con las dos marcadas distinto", async () => {
  const l = await leerAdjuntosParaClasificador("c1", [adj("factura.pdf", "application/pdf"), adj("carta.pdf", "application/pdf"), adj("captura.png", "image/png", 300_000)],
    visual({ "factura.pdf": { esGasto: true, resumen: "Uber · 26.971,00 COP · 2026-09-22" }, "carta.pdf": { esGasto: false, texto: "Les rogamos confirmen antes del 15/10 el nivel de servicio elegido." }, "captura.png": { esGasto: false, texto: "Reembolso de Rappi +US$0,83" } }));
  assert.deepEqual(l.map((x) => x.clase), ["factura", "documento", "documento"]);
  const sec = seccionAdjuntos(l);
  assert.match(sec, /«factura\.pdf» — comprobante de gasto \(se procesa aparte como gasto\): Uber · 26\.971,00 COP/);
  assert.match(sec, /«carta\.pdf» — leído con visión \(NO es un comprobante de gasto\):\nLes rogamos confirmen antes del 15\/10/);
  assert.doesNotMatch(sec, /factura\.pdf» — leído con visión/);
});

test("visión acotada: máximo 3 lecturas por correo, imágenes pequeñas no se leen, y un fallo o texto vacío se declara", async () => {
  const llamadas: string[] = [];
  const silenciar = console.error; console.error = () => undefined;
  try {
    const l = await leerAdjuntosParaClasificador("c1", [adj("logo.png", "image/png", MIN_BYTES_IMAGEN - 1), adj("a.pdf", "application/pdf"), adj("b.pdf", "application/pdf"), adj("c.pdf", "application/pdf"), adj("d.pdf", "application/pdf"), adj("roto.pdf", "application/pdf")],
      visual({ "a.pdf": { esGasto: false, texto: "a" }, "b.pdf": "error", "c.pdf": { esGasto: false, texto: "  " } }, llamadas));
    assert.match(l[0].motivo!, /imagen pequeña/);
    assert.deepEqual(llamadas.sort(), ["a.pdf", "b.pdf", "c.pdf"], `solo ${MAX_LECTURAS_VISUALES} lecturas visuales`);
    assert.deepEqual(l.slice(1, 4).map((x) => x.estado === "leido" ? "leido" : x.motivo), ["leido", "error al leerlo con visión", "no se pudo transcribir"]);
    assert.match(l[4].motivo!, /primeros 3 PDF o imágenes/);
  } finally { console.error = silenciar; }
});

test("las lecturas visuales corren en paralelo: la latencia es la de una, no la suma", async () => {
  const deps: DependenciasAdjuntos = { descargar: async () => Buffer.from("x"), extraer: async () => undefined, leerVisual: async () => { await new Promise((r) => setTimeout(r, 80)); return { esGasto: false, texto: "t" }; } };
  const t0 = Date.now();
  await leerAdjuntosParaClasificador("c1", [adj("a.pdf", "application/pdf"), adj("b.pdf", "application/pdf"), adj("c.pdf", "application/pdf")], deps);
  assert.ok(Date.now() - t0 < 200, "tres lecturas de 80 ms en serie tardarían 240 ms");
});

test("el interruptor de la lectura visual", () => {
  assert.equal(lecturaVisualActiva({}), true);
  assert.equal(lecturaVisualActiva({ WOBI_LECTURA_ADJUNTOS_VISUAL: "false" }), false);
  assert.equal(lecturaVisualActiva({ WOBI_LECTURA_ADJUNTOS_VISUAL: "FALSE " }), false);
  assert.equal(lecturaVisualActiva({ WOBI_LECTURA_ADJUNTOS_VISUAL: "tal vez" }), true, "una errata no apaga la lectura");
});

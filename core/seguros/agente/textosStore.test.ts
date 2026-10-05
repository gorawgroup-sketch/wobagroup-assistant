import assert from "node:assert/strict";
import test from "node:test";
import { AVISO_RESPUESTA_RECORTADA, ejecutarBucle } from "./bucle";
import { reunir, textoDeDocumento, trocear, versionDeBytes, type AlmacenTextos, type LectorDocumentos } from "./textosStore";

function almacenEnMemoria() {
  const mapa = new Map<string, { version: string; texto: string }>();
  const almacen: AlmacenTextos & { mapa: typeof mapa; guardados: number } = {
    mapa, guardados: 0,
    buscar: async (docId, version) => (mapa.get(docId)?.version === version ? (mapa.get(docId) as { texto: string }).texto : null),
    guardar: async (docId, version, _nombre, texto) => { almacen.guardados++; mapa.set(docId, { version, texto }); },
  };
  return almacen;
}

function lectorFalso(bytes = Buffer.from("contenido v1"), mimeType = "application/pdf") {
  const llamadas = { descargar: 0, deterministico: 0, transcribir: 0 };
  const lector: LectorDocumentos & { llamadas: typeof llamadas; bytes: Buffer } = {
    llamadas, bytes,
    descargar: async () => { llamadas.descargar++; return { bytes: lector.bytes, mimeType, name: "Condiciones.pdf" }; },
    deterministico: async () => { llamadas.deterministico++; return mimeType.includes("word") ? "texto word" : undefined; },
    esVisual: (m) => m === "application/pdf" || m.startsWith("image/"),
    transcribir: async () => { llamadas.transcribir++; return "TRANSCRIPCIÓN COMPLETA"; },
  };
  return lector;
}

const DOC = { id: "doc1", name: "Condiciones.pdf", folderPath: "SEGUROS" };

test("un PDF se transcribe con visión UNA sola vez: la segunda lectura sale de la caché sin pagar IA", async () => {
  const almacen = almacenEnMemoria();
  const lector = lectorFalso();
  const primera = await textoDeDocumento(DOC, "ctx", lector, almacen);
  assert.deepEqual(primera, { texto: "TRANSCRIPCIÓN COMPLETA", desdeCache: false });
  const segunda = await textoDeDocumento(DOC, "ctx", lector, almacen);
  assert.deepEqual(segunda, { texto: "TRANSCRIPCIÓN COMPLETA", desdeCache: true });
  assert.equal(lector.llamadas.transcribir, 1);
  assert.equal(almacen.guardados, 1);
});

test("si el documento cambia (otros bytes), la copia vieja no se usa y se vuelve a leer", async () => {
  const almacen = almacenEnMemoria();
  const lector = lectorFalso();
  await textoDeDocumento(DOC, "ctx", lector, almacen);
  lector.bytes = Buffer.from("contenido v2 distinto");
  const r = await textoDeDocumento(DOC, "ctx", lector, almacen);
  assert.equal(r.desdeCache, false);
  assert.equal(lector.llamadas.transcribir, 2);
  assert.notEqual(versionDeBytes(Buffer.from("contenido v1")), versionDeBytes(Buffer.from("contenido v2 distinto")));
});

test("un formato que se lee sin IA (Word) no usa visión", async () => {
  const lector = lectorFalso(Buffer.from("w"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const r = await textoDeDocumento(DOC, "ctx", lector, almacenEnMemoria());
  assert.equal(r.texto, "texto word");
  assert.equal(lector.llamadas.transcribir, 0);
});

test("un formato que ni se lee sin IA ni es visual falla con un mensaje claro, sin inventar texto", async () => {
  const lector = lectorFalso(Buffer.from("z"), "application/zip");
  await assert.rejects(textoDeDocumento(DOC, "ctx", lector, almacenEnMemoria()), /no expone texto verificable/);
});

test("si la caché falla (al buscar o al guardar) el documento se lee igual: la caché es una ayuda, no un requisito", async () => {
  const lector = lectorFalso();
  const rota: AlmacenTextos = { buscar: async () => { throw new Error("Sheets 429"); }, guardar: async () => { throw new Error("Sheets 429"); } };
  const r = await textoDeDocumento(DOC, "ctx", lector, rota);
  assert.equal(r.texto, "TRANSCRIPCIÓN COMPLETA");
  assert.equal(r.desdeCache, false);
});

test("un texto largo se trocea para caber en las celdas y se reconstruye entero; con un trozo que falta no se devuelve nada", () => {
  const texto = "x".repeat(95_000) + "FIN";
  const trozos = trocear(texto);
  assert.equal(trozos.length, 3);
  assert.ok(trozos.every((t) => t.length <= 40_000));
  const filas = trozos.map((t, i) => ({ parte: i + 1, partes: trozos.length, texto: t }));
  assert.equal(reunir(filas), texto);
  assert.equal(reunir(filas.slice(0, 2)), null);
  assert.equal(reunir([]), null);
  assert.equal(reunir([filas[0], filas[2], filas[2]]), null);
});

test("una respuesta del modelo cortada por longitud lleva el aviso, nunca se entrega como completa", async () => {
  const r = await ejecutarBucle({
    system: [{ type: "text", text: "s" }], mensajeInicial: "q", herramientas: [], modelo: "m", maxIteraciones: 3, maxTokensRespuesta: 10,
    crearMensaje: async () => ({ id: "m", type: "message", role: "assistant", model: "m", stop_reason: "max_tokens", stop_sequence: null, content: [{ type: "text", text: "Cubre la RC general y quedando siempre excluidos", citations: null }], usage: { input_tokens: 1, output_tokens: 1 } } as never),
  });
  assert.match(r.texto, /quedando siempre excluidos\n\n\[Respuesta recortada por longitud/);
  assert.ok(r.texto.endsWith(AVISO_RESPUESTA_RECORTADA));
});

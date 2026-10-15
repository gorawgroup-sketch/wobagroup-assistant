import assert from "node:assert/strict";
import test from "node:test";
import { prepararEntradaArchivoConOrden } from "./entradaArchivoConOrden";
import type { TelegramUpdate } from "./types";

const PIE_ORDEN = "Considerando este cuadro envíale un correo a Yanessy con copia a Alberto y a Simón";

function fotoConPie(caption: string | undefined, extra: Record<string, unknown> = {}): TelegramUpdate {
  return { update_id: 1, message: { message_id: 7, from: { id: 5, is_bot: false, first_name: "Carlos" }, chat: { id: 5, type: "private" }, date: 1, caption, photo: [{ file_id: "f1", file_unique_id: "u1", width: 10, height: 10, file_size: 100 }], ...extra } } as TelegramUpdate;
}

function dependencias(sobre: Record<string, unknown> = {}) {
  const llamadas = { pregunta: 0, descarga: 0, lectura: 0, avisos: [] as string[] };
  return {
    llamadas,
    deps: {
      modoConocimientoActivo: async () => false,
      pideAccion: async () => { llamadas.pregunta++; return true; },
      descargar: async () => { llamadas.descarga++; return Buffer.from("x"); },
      leer: async () => { llamadas.lectura++; return "MOD 111  4.127,11\nMOD 202  218,45"; },
      avisar: async (_chat: number, texto: string) => { llamadas.avisos.push(texto); },
      ...sobre,
    },
  };
}

test("una foto con una orden en el pie sigue como mensaje de texto con la orden y el contenido leído", async () => {
  const { deps, llamadas } = dependencias();
  const r = await prepararEntradaArchivoConOrden(fotoConPie(PIE_ORDEN), deps);
  assert.ok(r?.message);
  assert.equal(r.message.photo, undefined);
  assert.equal(r.message.caption, undefined);
  assert.equal(r.message.message_id, 7);
  assert.match(r.message.text ?? "", /^Considerando este cuadro envíale un correo a Yanessy con copia a Alberto y a Simón\n/);
  assert.match(r.message.text ?? "", /<adjunto_leido>\nMOD 111 {2}4\.127,11/);
  assert.equal(llamadas.avisos.length, 1);
});

test("sin pie, con pie corto o con pie de descripción el archivo sigue el flujo documental", async () => {
  const a = dependencias();
  assert.equal(await prepararEntradaArchivoConOrden(fotoConPie(undefined), a.deps), undefined);
  assert.equal(await prepararEntradaArchivoConOrden(fotoConPie("factura Uber"), a.deps), undefined);
  assert.equal(a.llamadas.pregunta, 0, "un pie corto no gasta ni una llamada de IA");
  const b = dependencias({ pideAccion: async () => false });
  assert.equal(await prepararEntradaArchivoConOrden(fotoConPie("Factura de Uber de la semana pasada para archivar"), b.deps), undefined);
  assert.equal(b.llamadas.descarga, 0, "si no es orden no se descarga ni se lee nada");
});

test("con el modo conocimiento activo o con un CSV nunca se interpreta el pie", async () => {
  const a = dependencias({ modoConocimientoActivo: async () => true });
  assert.equal(await prepararEntradaArchivoConOrden(fotoConPie(PIE_ORDEN), a.deps), undefined);
  assert.equal(a.llamadas.pregunta, 0);
  const b = dependencias();
  const csv = fotoConPie(PIE_ORDEN, { photo: undefined, document: { file_id: "d1", file_unique_id: "u2", file_name: "extracto.csv", mime_type: "text/csv" } });
  assert.equal(await prepararEntradaArchivoConOrden(csv, b.deps), undefined);
  assert.equal(b.llamadas.pregunta, 0);
});

test("si falla la decisión o la lectura, el archivo no se pierde: sigue el flujo documental", async () => {
  const a = dependencias({ pideAccion: async () => { throw new Error("sin API"); } });
  assert.equal(await prepararEntradaArchivoConOrden(fotoConPie(PIE_ORDEN), a.deps), undefined);
  const b = dependencias({ leer: async () => { throw new Error("ilegible"); } });
  assert.equal(await prepararEntradaArchivoConOrden(fotoConPie(PIE_ORDEN), b.deps), undefined);
  assert.equal(b.llamadas.avisos.length, 0, "no se avisa de una orden que no se pudo preparar");
  const c = dependencias({ leer: async () => "   " });
  assert.equal(await prepararEntradaArchivoConOrden(fotoConPie(PIE_ORDEN), c.deps), undefined);
});

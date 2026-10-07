import test from "node:test";
import assert from "node:assert/strict";
import { esImagen, lecturaSinDatosContables, sustitutoSiElArchivoNoTieneInformacion, type DependenciasSoporteSinInformacion } from "./soporteSinInformacion";
import type { DatosFactura } from "./extractInvoiceData";

const datos = (extra: Partial<DatosFactura> = {}): DatosFactura => ({ esFacturaOGasto: true, proveedor: "Booking.com", monto: 207.09, moneda: "EUR", fecha: "2026-09-07", concepto: "Hospedaje", reciboSimplificado: true, lineas: [], confianza: "media", razon: "x", ...extra } as DatosFactura);

function deps(sola: Partial<DatosFactura>, extra: Partial<DependenciasSoporteSinInformacion> = {}) {
  const llamadas = { sinContexto: 0, pdf: 0, escritos: [] as string[] };
  const d: DependenciasSoporteSinInformacion = {
    leerSinContexto: async () => { llamadas.sinContexto++; return datos(sola); },
    generarPdf: async () => { llamadas.pdf++; return Buffer.from("%PDF-1.7 desde cuerpo"); },
    cuerpo: async () => "Cuerpo del correo con la reserva 123456",
    html: async () => "<html>correo</html>",
    resumen: async () => ({ id: "m1", threadId: "t1", messageIdHeader: "h", de: "Carlos <c@x.com>", asunto: "Hospedaje", fecha: "2026-09-07", extracto: "", adjuntos: [] }),
    escribir: async (ruta) => { llamadas.escritos.push(ruta); },
    ...extra,
  };
  return { d, llamadas };
}
const base = { rutaLocal: "/tmp/x.png", mimeType: "image/png", nombreArchivo: "mapa.png", mensajeIdGmail: "m1" };

test("caso Antaris: la captura de un mapa (marcada sin datos y sin datos al leerla sola) se sustituye por el PDF del cuerpo", async () => {
  const { d, llamadas } = deps({ proveedor: "", monto: 0 });
  const r = await sustitutoSiElArchivoNoTieneInformacion({ ...base, datos: datos({ datosEnElDocumento: false }) }, d);
  assert.equal(r?.mimeType, "application/pdf");
  assert.match(r?.rutaLocal ?? "", /comprobante_desde_cuerpo\.pdf$/);
  assert.equal(llamadas.pdf, 1);
  assert.equal(llamadas.escritos.length, 1);
});

test("si el lector dijo que los datos SÍ están en el archivo (o no dijo nada), no se toca ni se gasta una segunda lectura", async () => {
  for (const flag of [true, undefined]) {
    const { d, llamadas } = deps({ proveedor: "", monto: 0 });
    assert.equal(await sustitutoSiElArchivoNoTieneInformacion({ ...base, datos: datos({ datosEnElDocumento: flag }) }, d), undefined);
    assert.equal(llamadas.sinContexto, 0);
  }
});

test("una foto real de un recibo nunca se sustituye: la segunda lectura sin contexto sí encuentra proveedor e importe", async () => {
  const { d, llamadas } = deps({ proveedor: "Raku Cafe", monto: 85 });
  assert.equal(await sustitutoSiElArchivoNoTieneInformacion({ ...base, datos: datos({ datosEnElDocumento: false }) }, d), undefined);
  assert.equal(llamadas.sinContexto, 1);
  assert.equal(llamadas.pdf, 0);
});

test("solo imágenes y solo adjuntos de un correo de Gmail: un PDF o un archivo de Telegram no se sustituye", async () => {
  const { d, llamadas } = deps({ proveedor: "", monto: 0 });
  assert.equal(await sustitutoSiElArchivoNoTieneInformacion({ ...base, mimeType: "application/pdf", datos: datos({ datosEnElDocumento: false }) }, d), undefined);
  assert.equal(await sustitutoSiElArchivoNoTieneInformacion({ ...base, mensajeIdGmail: undefined, datos: datos({ datosEnElDocumento: false }) }, d), undefined);
  assert.equal(llamadas.sinContexto, 0);
});

test("los fallos se propagan (quien llama conserva el archivo original)", async () => {
  const { d } = deps({ proveedor: "", monto: 0 }, { generarPdf: async () => { throw new Error("Chromium caído"); } });
  await assert.rejects(() => sustitutoSiElArchivoNoTieneInformacion({ ...base, datos: datos({ datosEnElDocumento: false }) }, d), /Chromium caído/);
});

test("utilidades: imagen y lectura sin datos contables", () => {
  assert.equal(esImagen("image/jpeg"), true);
  assert.equal(esImagen("application/pdf"), false);
  assert.equal(esImagen(undefined), false);
  assert.equal(lecturaSinDatosContables({ proveedor: "", monto: 0 }), true);
  assert.equal(lecturaSinDatosContables({ proveedor: "Booking", monto: 0 }), true);
  assert.equal(lecturaSinDatosContables({ proveedor: "", monto: 10 }), true);
  assert.equal(lecturaSinDatosContables({ proveedor: "Booking", monto: 10 }), false);
});

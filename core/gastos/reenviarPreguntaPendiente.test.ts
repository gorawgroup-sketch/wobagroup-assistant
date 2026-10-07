import assert from "node:assert/strict";
import test from "node:test";
import { filtrarConciliacionesPorTexto } from "./reenviarPreguntaPendiente";

const pendientes = [
  { descripcionGasto: "AirGSM PTE. LTD. (Airalo) — 12.5 USD", proveedor: "AirGSM PTE. LTD.", monto: 12.5 },
  { descripcionGasto: "Board Riders Inc — 35.62 USD", proveedor: "Board Riders Inc", monto: 35.62 },
  { descripcionGasto: "Uber — 11.17 USD", proveedor: "", monto: 11.17 },
];

test("sin texto devuelve todas las preguntas pendientes", () => {
  assert.equal(filtrarConciliacionesPorTexto(pendientes, "").length, 3);
});

test("resuelve por nombre (parte del proveedor o de la descripción), sin que un proveedor vacío coincida con todo", () => {
  assert.deepEqual(filtrarConciliacionesPorTexto(pendientes, "airalo").map(p => p.monto), [12.5]);
  assert.deepEqual(filtrarConciliacionesPorTexto(pendientes, "Board Riders").map(p => p.monto), [35.62]);
  assert.deepEqual(filtrarConciliacionesPorTexto(pendientes, "uber").map(p => p.monto), [11.17]);
});

test("resuelve por monto con coma o punto y devuelve vacío si nada coincide", () => {
  assert.deepEqual(filtrarConciliacionesPorTexto(pendientes, "12,50").map(p => p.monto), [12.5]);
  assert.deepEqual(filtrarConciliacionesPorTexto(pendientes, "35.62 USD").map(p => p.monto), [35.62]);
  assert.deepEqual(filtrarConciliacionesPorTexto(pendientes, "Cratevo"), []);
});

test("la pregunta de un gasto al que falta un dato se reconstruye según el motivo (caso Lunch 180 MXN)", async () => {
  const { textoPreguntaGastoPendienteDatos } = await import("./reenviarPreguntaPendiente");
  const base = {
    id: "73ddb5f9", chatId: 1, rutaLocal: "/tmp/x.jpg", nombreArchivoOriginal: "x.jpg", creadoEn: 0,
    datos: { proveedor: "Cnidos y Rifados", monto: 180, moneda: "MXN" } as never,
  };
  const moneda = textoPreguntaGastoPendienteDatos({ ...base, motivo: "moneda" });
  assert.match(moneda, /Cnidos y Rifados/);
  assert.match(moneda, /180 MXN/);
  assert.match(moneda, /monto EXACTO y la moneda/);
  assert.match(moneda, /descarta la pregunta pendiente del gasto/);
  assert.match(textoPreguntaGastoPendienteDatos({ ...base, motivo: "empresa" }), /WOBA, EWORKS o Footprint/);
  assert.match(textoPreguntaGastoPendienteDatos({ ...base, motivo: "fecha" }), /AAAA-MM-DD/);
  assert.match(textoPreguntaGastoPendienteDatos({ ...base, motivo: "proveedor" }), /proveedor/);
  const verificacion = textoPreguntaGastoPendienteDatos({ ...base, motivo: "verificacion_duplicado" });
  assert.match(verificacion, /verificación de duplicados/);
  assert.doesNotMatch(verificacion, /descarta la pregunta/);
});

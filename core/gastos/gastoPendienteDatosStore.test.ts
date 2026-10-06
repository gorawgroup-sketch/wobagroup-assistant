import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Regresión de producción: append desplazó A:K a J:T; el vigilante no veía la pendiente.
test('crear y restaurar pendientes usan escritura explícita verificada, nunca append', async () => {
  const source = await readFile(join(process.cwd(), 'core/gastos/gastoPendienteDatosStore.ts'), 'utf8');
  assert.doesNotMatch(source, /values\.append/);
  assert.equal(source.match(/await agregarFila\(TAB_NAME, HEADERS.length, HEADERS, pendienteToRow\(pendiente\)\)/g)?.length, 2);
  assert.match(source, /leerFilas\(TAB_NAME, HEADERS.length, HEADERS\)/);
  assert.match(source, /eliminarFilaKV\(TAB_NAME, rowIndex, HEADERS\)/);
});

// --- el mismo adjunto no acumula pendientes (caso Anthropic, 2026-10-06: 4 filas para un solo pago) --------------------------------------

import { esMismoAdjuntoPendiente } from "./gastoPendienteDatosStore";
import { readFile as leerArchivoFuente } from "node:fs/promises";
import { join as unirRuta } from "node:path";

const adjunto = (parcial: Record<string, unknown>) => ({ chatId: 7, nombreArchivoOriginal: "Receipt.pdf", correoOrigen: undefined, origenAdjuntoGmail: undefined, ...parcial }) as never;

test("es el mismo adjunto si coincide el mensaje de Gmail y la parte MIME; sin parte, por nombre; nunca entre chats ni sin correo de origen", () => {
  const base = { origenAdjuntoGmail: { mensajeIdGmail: "m1", attachmentIdGmail: "a1", partId: "2" } };
  assert.equal(esMismoAdjuntoPendiente(adjunto(base), adjunto({ origenAdjuntoGmail: { mensajeIdGmail: "m1", attachmentIdGmail: "OTRO", partId: "2" } })), true, "el attachmentId cambia entre lecturas; la parte no");
  assert.equal(esMismoAdjuntoPendiente(adjunto(base), adjunto({ origenAdjuntoGmail: { mensajeIdGmail: "m1", attachmentIdGmail: "a2", partId: "1" } })), false, "otra parte del mismo correo es otro documento (Invoice y Receipt)");
  assert.equal(esMismoAdjuntoPendiente(adjunto(base), adjunto({ origenAdjuntoGmail: { mensajeIdGmail: "m2", attachmentIdGmail: "a1", partId: "2" } })), false, "otro correo");
  assert.equal(esMismoAdjuntoPendiente(adjunto({ correoOrigen: { mensajeIdGmail: "m1" } }), adjunto({ correoOrigen: { mensajeIdGmail: "m1" } })), true, "sin parte: mismo nombre de archivo");
  assert.equal(esMismoAdjuntoPendiente(adjunto({ correoOrigen: { mensajeIdGmail: "m1" } }), adjunto({ correoOrigen: { mensajeIdGmail: "m1" }, nombreArchivoOriginal: "Invoice.pdf" })), false, "sin parte y con otro nombre");
  assert.equal(esMismoAdjuntoPendiente(adjunto({ chatId: 1, ...base }), adjunto({ chatId: 2, ...base })), false, "otro chat");
  assert.equal(esMismoAdjuntoPendiente(adjunto({}), adjunto({})), false, "una subida manual (sin correo de origen) nunca sustituye a otra");
  assert.equal(esMismoAdjuntoPendiente(adjunto({ nombreArchivoOriginal: "" , correoOrigen: { mensajeIdGmail: "m1" } }), adjunto({ nombreArchivoOriginal: "", correoOrigen: { mensajeIdGmail: "m1" } })), false, "sin nombre ni parte no hay identidad");
});

test("guardar una pendiente sustituye las del mismo adjunto, borrando de mayor a menor fila", async () => {
  const fuente = await leerArchivoFuente(unirRuta(process.cwd(), "core/gastos/gastoPendienteDatosStore.ts"), "utf8");
  assert.match(fuente, /filter\(\(\{ pendiente \}\) => esMismoAdjuntoPendiente\(pendiente, datos\)\)/);
  assert.match(fuente, /anteriores\.sort\(\(a, b\) => b\.rowIndex - a\.rowIndex\);\s*for \(const \{ rowIndex \} of anteriores\) await eliminarFila\(rowIndex\);/);
});


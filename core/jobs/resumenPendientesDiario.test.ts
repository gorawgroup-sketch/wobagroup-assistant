import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const RUTA_FUENTE = join(process.cwd(), "core/jobs/resumenPendientesDiario.ts");

test("la limpieza masiva vacía solo la cola local y nunca cambia UNREAD en Gmail", async () => {
  const fuente = await readFile(RUTA_FUENTE, "utf8");
  const inicio = fuente.indexOf("async function descartarTodosLosPendientes");
  const final = fuente.indexOf("async function descartarUnPendiente", inicio);
  assert.notEqual(inicio, -1, "no se encontró la función de limpieza masiva");
  assert.notEqual(final, -1, "no se encontró el límite de la función de limpieza masiva");

  const limpiezaMasiva = fuente.slice(inicio, final);
  assert.match(limpiezaMasiva, /vaciarColaCorreoDelChat\(chatId\)/);
  assert.doesNotMatch(limpiezaMasiva, /marcarHiloComoLeido|removeLabelIds/);
  assert.doesNotMatch(fuente, /from\s+["']\.\.\/gmail\/client["']/);
});

test("el botón masivo exige confirmación y declara que Gmail sigue sin leer", async () => {
  const fuente = await readFile(RUTA_FUENTE, "utf8");
  assert.match(fuente, /resumen_descartar_todo:confirmar/);
  assert.match(fuente, /resumen_descartar_todo:cancelar/);
  assert.match(fuente, /permanecerán SIN LEER/);
});

test("las conversaciones automáticas sin decidir se pueden descartar una a una y en bloque, siempre como NO automáticas", async () => {
  const fuente = await readFile(RUTA_FUENTE, "utf8");
  assert.match(fuente, /tipo: "hilo_autorespuesta", subId: h\.threadId/);
  assert.match(fuente, /hilo_autorespuesta: "ha"/);

  const inicioMasiva = fuente.indexOf("async function descartarTodosLosPendientes");
  const finalMasiva = fuente.indexOf("async function descartarUnPendiente", inicioMasiva);
  const limpiezaMasiva = fuente.slice(inicioMasiva, finalMasiva);
  assert.match(limpiezaMasiva, /resolverHiloAutorespuesta\(h\.threadId, "rechazado"\)/);

  const inicioIndividual = fuente.indexOf('case "hilo_autorespuesta"');
  const individual = fuente.slice(inicioIndividual, fuente.indexOf("}", fuente.indexOf("resolverHiloAutorespuesta", inicioIndividual)));
  assert.match(individual, /obtenerPendientesHiloAutorespuestaPorChat\(chatId\)/, "debe verificar que el hilo es de este chat");
  assert.match(individual, /resolverHiloAutorespuesta\(subId, "rechazado"\)/);
  assert.doesNotMatch(fuente, /resolverHiloAutorespuesta\([^)]*"aprobado"\)/, "el resumen jamás puede aprobar una conversación automática");
});

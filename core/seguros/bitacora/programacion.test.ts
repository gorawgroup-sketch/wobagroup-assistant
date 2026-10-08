import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { GRACIA_MS, PROGRAMACION_SEGUROS, estadoDeTarea, ocurrenciasEntre, proximaOcurrencia, tareaProgramada, textoCuando, ultimaOcurrencia } from "./programacion";

const ms = (iso: string) => Date.parse(iso);
const iso = (valor: number | null) => (valor == null ? null : new Date(valor).toISOString());

test("la frase de «cuándo trabaja» de cada tarea", () => {
  assert.equal(textoCuando(tareaProgramada("vigilante")), "Todos los días a las 08:35 y 17:35 (hora de Madrid)");
  assert.equal(textoCuando(tareaProgramada("avisos")), "Todos los días a las 08:50 (hora de Madrid)");
  assert.equal(textoCuando(tareaProgramada("pagos")), "Todos los días a las 08:55 (hora de Madrid)");
  assert.equal(textoCuando(tareaProgramada("semanal")), "Los lunes a las 09:10 (hora de Madrid)");
  assert.equal(textoCuando(tareaProgramada("agente")), "Cuando le preguntas");
});

test("las citas siguen la hora de Madrid también al cambiar el horario (fin del horario de verano: domingo 25/10/2026)", () => {
  const citas = ocurrenciasEntre(tareaProgramada("vigilante"), ms("2026-10-24T00:00:00Z"), ms("2026-10-26T23:59:00Z")).map(iso);
  assert.deepEqual(citas, [
    "2026-10-24T06:35:00.000Z", "2026-10-24T15:35:00.000Z", // CEST (UTC+2)
    "2026-10-25T07:35:00.000Z", "2026-10-25T16:35:00.000Z", // CET (UTC+1): ya cambió la hora
    "2026-10-26T07:35:00.000Z", "2026-10-26T16:35:00.000Z",
  ]);
});

test("el resumen semanal solo cita los lunes", () => {
  const citas = ocurrenciasEntre(tareaProgramada("semanal"), ms("2026-10-06T00:00:00Z"), ms("2026-10-20T00:00:00Z")).map(iso);
  assert.deepEqual(citas, ["2026-10-12T07:10:00.000Z", "2026-10-19T07:10:00.000Z"]);
});

test("última y próxima cita de cada tarea desde un instante dado (jueves 08/10/2026, 17:36 en Madrid)", () => {
  const ahora = ms("2026-10-08T15:36:00Z");
  const par = (id: Parameters<typeof tareaProgramada>[0]) => [iso(ultimaOcurrencia(tareaProgramada(id), ahora)), iso(proximaOcurrencia(tareaProgramada(id), ahora))];
  assert.deepEqual(par("vigilante"), ["2026-10-08T15:35:00.000Z", "2026-10-09T06:35:00.000Z"]);
  assert.deepEqual(par("avisos"), ["2026-10-08T06:50:00.000Z", "2026-10-09T06:50:00.000Z"]);
  assert.deepEqual(par("pagos"), ["2026-10-08T06:55:00.000Z", "2026-10-09T06:55:00.000Z"]);
  assert.deepEqual(par("semanal"), ["2026-10-05T07:10:00.000Z", "2026-10-12T07:10:00.000Z"]);
  assert.deepEqual(par("agente"), [null, null], "el especialista no tiene citas: responde cuando le hablan");
});

test("estado de cada tarea: al día, retrasada, sin constancia, sin lectura y bajo demanda", () => {
  const vigilante = tareaProgramada("vigilante");
  const programada = (cuando: string, tarea = "vigilante" as const) => ({ tarea, origen: "programada" as const, cuando });
  // 16:10Z: la última cita (15:35Z) pasó hace 35 min, más que el margen.
  const ahora = ms("2026-10-08T16:10:00Z");
  assert.equal(estadoDeTarea(vigilante, [programada("2026-10-08T15:35:40Z")], ahora), "al_dia");
  assert.equal(estadoDeTarea(vigilante, [programada("2026-10-08T06:35:40Z")], ahora), "retrasada", "solo consta la de la mañana: la de la tarde no dejó constancia");
  assert.equal(estadoDeTarea(vigilante, [], ahora), "sin_registro");
  assert.equal(estadoDeTarea(vigilante, [programada("2026-10-08T15:35:40Z", "pagos" as never)], ahora), "sin_registro", "la constancia de otra tarea no cuenta");
  assert.equal(estadoDeTarea(vigilante, [{ tarea: "vigilante", origen: "manual", cuando: "2026-10-08T15:50:00Z" }], ahora), "sin_registro", "una revisión pedida a mano no demuestra que el planificador funcione");
  assert.equal(estadoDeTarea(vigilante, null, ahora), "sin_lectura");
  assert.equal(estadoDeTarea(tareaProgramada("agente"), [], ahora), "bajo_demanda");
});

test("una tarea que acaba de tocar no se da por retrasada hasta pasado el margen (la constancia se escribe al terminar)", () => {
  const vigilante = tareaProgramada("vigilante");
  const solaLaDeLaManana = [{ tarea: "vigilante" as const, origen: "programada" as const, cuando: "2026-10-08T06:35:40Z" }];
  assert.equal(estadoDeTarea(vigilante, solaLaDeLaManana, ms("2026-10-08T15:35:00Z") + GRACIA_MS - 1), "al_dia");
  assert.equal(estadoDeTarea(vigilante, solaLaDeLaManana, ms("2026-10-08T15:35:00Z") + GRACIA_MS + 1), "retrasada");
});

test("guardarraíl: la programación que se enseña coincide con las cadenas cron reales del planificador", () => {
  const fuente = readFileSync(join(__dirname, "..", "..", "jobs", "scheduler.ts"), "utf8");
  const reales = new Map<string, string>();
  for (const m of fuente.matchAll(/cron\.schedule\(\s*"([^"]+)",\s*\(\)\s*=>\s*\{\s*ejecutarSinSolapamiento\("(\w+)"/g)) reales.set(m[2], m[1]);

  for (const tarea of PROGRAMACION_SEGUROS.filter((t) => t.job)) {
    assert.equal(reales.get(tarea.job!), tarea.cron, `${tarea.job}: lo que se enseña (${tarea.cron}) no coincide con scheduler.ts (${reales.get(tarea.job!)})`);
    const [minuto, horas, , , diaSemana] = tarea.cron!.split(" ");
    assert.deepEqual(tarea.horas, horas.split(",").map((h) => `${h.padStart(2, "0")}:${minuto.padStart(2, "0")}`), `${tarea.id}: las horas no salen de su cron`);
    assert.equal(tarea.dias === "lunes", diaSemana === "1", `${tarea.id}: el día no sale de su cron`);
  }
  assert.ok(PROGRAMACION_SEGUROS.filter((t) => t.job).length >= 4, "las cuatro tareas del planificador están en la lista");
});

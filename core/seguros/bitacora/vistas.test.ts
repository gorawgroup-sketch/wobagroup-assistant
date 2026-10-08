import assert from "node:assert/strict";
import test from "node:test";
import { pago } from "../pagos/pruebas";
import { entrada } from "./pruebas";
import { ENTRADAS_A_LEER, MAX_ENTRADAS_EN_CONTRATO, vistaBitacora, vistaCalendario, vistaCalendarioPagos, vistaProgramacion } from "./vistas";

// --- bitácora -----------------------------------------------------------------------------------------------------

test("sin lectura de la bitácora el contrato dice null (no «sin actividad»)", () => {
  assert.equal(vistaBitacora(undefined), null);
  assert.deepEqual(vistaBitacora([]), []);
});

test("la bitácora sale con lo último primero, con su etiqueta, acotada y con el texto de los avisos recortado", () => {
  const muchas = Array.from({ length: MAX_ENTRADAS_EN_CONTRATO + 10 }, (_, i) => entrada({ id: `e${i}`, cuando: new Date(Date.UTC(2026, 9, 1, 8, i)).toISOString() }));
  const vista = vistaBitacora(muchas)!;
  assert.equal(vista.length, MAX_ENTRADAS_EN_CONTRATO);
  assert.equal(vista[0].id, `e${MAX_ENTRADAS_EN_CONTRATO + 9}`, "la más reciente primero");
  assert.equal(vista[0].etiqueta, "Vigilante");

  const larga = vistaBitacora([entrada({ detalle: { avisos: [{ canal: "telegram", titulo: "T", texto: "y".repeat(3000), entregado: true }] } })])!;
  assert.ok(larga[0].avisos[0].texto.length <= 700);
  assert.match(larga[0].avisos[0].texto, /…$/);
  assert.deepEqual(larga[0].eventos, []);
  assert.deepEqual(larga[0].cifras, {});
  assert.deepEqual(larga[0].notas, []);
});

// --- programación -------------------------------------------------------------------------------------------------

test("la programación enseña cada tarea con su próxima cita, su última constancia y su estado", () => {
  const ahora = new Date("2026-10-08T16:10:00Z");
  const vista = vistaProgramacion([
    entrada({ tarea: "vigilante", cuando: "2026-10-08T15:35:40.000Z", resultado: "con_novedades", resumen: "Novedades: 1 pago confirmado" }),
    entrada({ id: "otra", tarea: "vigilante", cuando: "2026-10-08T06:35:40.000Z" }),
    entrada({ id: "pagos1", tarea: "pagos", cuando: "2026-10-08T06:55:30.000Z" }),
  ], ahora);
  assert.deepEqual(vista.map((t) => t.id), ["vigilante", "avisos", "pagos", "semanal", "agente"]);
  const vigilante = vista[0];
  assert.equal(vigilante.cuando, "Todos los días a las 08:35 y 17:35 (hora de Madrid)");
  assert.equal(vigilante.proxima, "2026-10-09T06:35:00.000Z");
  assert.deepEqual(vigilante.ultima, { cuando: "2026-10-08T15:35:40.000Z", resultado: "con_novedades", resumen: "Novedades: 1 pago confirmado", origen: "programada" });
  assert.equal(vigilante.estado, "al_dia");
  assert.equal(vista[1].estado, "sin_registro", "los avisos aún no tienen constancia");
  assert.equal(vista[1].ultima, null);
  assert.equal(vista[2].estado, "al_dia");
  assert.equal(vista[4].estado, "bajo_demanda");
  assert.equal(vista[4].proxima, null);
  assert.equal(vista[4].conIA, true);
});

test("si no se pudo leer la bitácora, la programación sigue (lo que corre no depende de leerla) pero no afirma si va al día", () => {
  const vista = vistaProgramacion(undefined, new Date("2026-10-08T16:10:00Z"));
  assert.equal(vista.length, 5);
  assert.deepEqual(vista.filter((t) => t.dias !== "bajo_demanda").map((t) => t.estado), ["sin_lectura", "sin_lectura", "sin_lectura", "sin_lectura"]);
  const sinHora = vistaProgramacion(undefined, null);
  assert.ok(sinHora.every((t) => t.proxima === null), "sin hora de referencia no se inventa la próxima cita");
});

// --- calendario de pagos ------------------------------------------------------------------------------------------

test("el calendario de pagos sale ordenado, con el estado de cada evento y sus avisos en palabras", () => {
  const hoy = "2026-10-08";
  const vista = vistaCalendarioPagos([
    pago({ id: "b", fecha: "2027-03-01", eventoCalendarId: "evt-b", avisos: "d3,d1" }),
    pago({ id: "a", fecha: "2027-02-27", eventoCalendarId: "" }),
    pago({ id: "cerrado", fecha: "2026-09-01", estado: "pagado", eventoCalendarId: "" }),
    pago({ id: "antiguo", fecha: "2026-01-01", estado: "pagado" }),
    pago({ id: "pasado", fecha: "2026-10-09", eventoCalendarId: "" }),
  ], hoy)!;
  assert.deepEqual(vista.map((p) => p.id), ["cerrado", "pasado", "a", "b"], "los cerrados antiguos (más de 90 días) no salen");
  const porId = Object.fromEntries(vista.map((p) => [p.id, p]));
  assert.equal(porId.b.evento.estado, "creado");
  assert.deepEqual(porId.b.avisosEnviados, ["aviso a 3 días", "aviso del día antes"]);
  assert.equal(porId.a.evento.estado, "pendiente", "se creará en la próxima pasada de las 8:55");
  assert.equal(porId.pasado.evento.estado, "no_aplica", "el día del evento (3 días antes) ya pasó y no se creó");
  assert.equal(porId.cerrado.evento.estado, "no_aplica");
  assert.equal(porId.a.diasRestantes, 142);
  assert.equal(porId.a.evento.inicio, "2027-02-24T08:00:00.000Z");
  assert.match(porId.a.evento.titulo, /^🛡️ Seguro: /);
  assert.equal(vistaCalendarioPagos(undefined, hoy), null, "sin lectura del calendario: null");
});

test("dónde quedan los eventos: la cuenta del asistente y si se invita a la persona", () => {
  const con = vistaCalendario("asistente@wobagroup.com", true);
  assert.equal(con.cuenta, "asistente@wobagroup.com");
  assert.equal(con.invitaACarlos, true);
  assert.match(con.texto, /te aparecen en tu propio Google Calendar/);
  const sin = vistaCalendario(undefined, false);
  assert.equal(sin.cuenta, null);
  assert.match(sin.texto, /no te aparecen en tu calendario/);
});

test("el estado de una tarea semanal no depende de que su constancia quepa entre las entradas que se enseñan", () => {
  // 50 constancias del vigilante, todas más recientes que la del resumen del lunes: el contrato solo enseña las 40 últimas,
  // pero el estado se calcula con todas las que se leen.
  const vigilante = Array.from({ length: 50 }, (_, i) => entrada({ id: `v${i}`, cuando: new Date(Date.UTC(2026, 9, 6, 6, 0, i)).toISOString() }));
  const semanal = entrada({ id: "s1", tarea: "semanal", cuando: "2026-10-05T07:10:30.000Z" });
  const todas = [...vigilante, semanal];
  assert.ok(todas.length <= ENTRADAS_A_LEER);
  assert.ok(!vistaBitacora(todas)!.some((b) => b.id === "s1"), "la del lunes queda fuera de las 40 que se enseñan");
  const programacion = vistaProgramacion(todas, new Date("2026-10-08T07:00:00Z"));
  assert.equal(programacion.find((t) => t.id === "semanal")!.estado, "al_dia");
  assert.equal(programacion.find((t) => t.id === "semanal")!.ultima?.cuando, "2026-10-05T07:10:30.000Z");
});

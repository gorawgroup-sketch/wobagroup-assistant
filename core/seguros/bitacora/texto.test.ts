import assert from "node:assert/strict";
import test from "node:test";
import { entrada } from "./pruebas";
import { fechaHoraMadrid, textoActividad } from "./texto";

test("la hora se enseña en Madrid, con el horario de verano y el de invierno", () => {
  assert.equal(fechaHoraMadrid("2026-10-08T15:35:07.000Z"), "08/10 17:35");
  assert.equal(fechaHoraMadrid("2027-01-15T08:00:00.000Z"), "15/01 09:00");
  assert.equal(fechaHoraMadrid("no es una fecha"), "no es una fecha");
});

test("la actividad en texto: lo último primero, con avisos, eventos, notas y la programación", () => {
  const entradas = [
    entrada({ id: "a", cuando: "2026-10-08T06:35:40.000Z", resumen: "Banco, correo y registro revisados: sin novedades" }),
    entrada({
      id: "b", tarea: "pagos", cuando: "2026-10-08T06:55:30.000Z", resultado: "con_novedades", resumen: "Calendario revisado: 6 pagos previstos",
      detalle: {
        eventos: [{ accion: "creado", titulo: "🛡️ Seguro: RC — 840,74 € el 27/02/2027", inicio: "2027-02-24T08:00:00.000Z" }],
        avisos: [
          { canal: "telegram", titulo: "🛡️ Seguros — pagos", texto: "Texto completo del aviso", entregado: false },
          { canal: "telegram", titulo: "Otro aviso", texto: "Texto del otro", entregado: true, entregadoEn: "2026-10-08T06:55:41.000Z", truncado: true },
        ],
        notas: ["No pude crear un evento"],
      },
    }),
  ];
  const ahora = new Date("2026-10-08T07:00:00Z"); // 09:00 en Madrid: ya han tocado las 8:35, 8:50 y 8:55
  const texto = textoActividad(entradas, { ahora, limite: 15 });
  const lineas = texto.split("\n");
  assert.match(lineas[0], /^Actividad de Wobi Seguros \(hora de Madrid\), la más reciente primero:$/);
  assert.match(lineas[1], /^- 08\/10 08:55 · Calendario de pagos · con novedades — Calendario revisado: 6 pagos previstos$/);
  assert.match(texto, /↳ evento de calendario creado: 🛡️ Seguro: RC — 840,74 € el 27\/02\/2027 \(24\/02 09:00\)/);
  assert.match(texto, /↳ aviso por Telegram \(NO llegó\): «🛡️ Seguros — pagos»/);
  assert.match(texto, /↳ aviso por Telegram \(entregado 08\/10 08:55\): «Otro aviso»/, "con la hora en que Telegram lo aceptó");
  assert.doesNotMatch(texto, /Texto completo del aviso/, "por defecto solo el título del aviso");
  assert.match(texto, /↳ No pude crear un evento/);
  assert.match(texto, /- 08\/10 08:35 · Vigilante · sin novedades — Banco, correo y registro revisados: sin novedades/);
  assert.match(texto, /Cuándo trabaja cada tarea:/);
  assert.match(texto, /- Vigilante: banco, correo y registro: Todos los días a las 08:35 y 17:35 \(hora de Madrid\) · próxima: 08\/10 17:35 · al día/);
  assert.match(texto, /- Avisos del registro: Todos los días a las 08:50 \(hora de Madrid\) · próxima: 09\/10 08:50 · aún sin constancia/);
  assert.match(texto, /- Especialista \(cuando le preguntas\): Cuando le preguntas · cuando se le pregunta/);

  const conTextos = textoActividad(entradas, { ahora, limite: 15, incluirTextos: true });
  assert.match(conTextos, /Texto completo del aviso/);
  assert.match(conTextos, /Texto del otro\n\[texto recortado\]/, "un aviso cortado al guardarlo lo dice");
});

test("filtra por tarea, limita y, sin constancia, dice que la bitácora es nueva en vez de inventar actividad", () => {
  const entradas = [entrada({ id: "a" }), entrada({ id: "b", tarea: "pagos" }), entrada({ id: "c", tarea: "pagos", cuando: "2026-10-09T06:55:00.000Z" })];
  const soloPagos = textoActividad(entradas, { ahora: new Date("2026-10-09T08:00:00Z"), tarea: "pagos", limite: 1 });
  assert.match(soloPagos, /la más reciente primero, solo «Calendario de pagos»:/);
  assert.equal(soloPagos.split("\n").filter((l) => l.startsWith("- ") && l.includes("Calendario de pagos ·")).length, 1, "respeta el límite");
  assert.match(textoActividad([], { ahora: new Date("2026-10-09T08:00:00Z"), limite: 15 }), /Aún no hay constancia en la bitácora/);
});

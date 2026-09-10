import assert from "node:assert/strict";
import test from "node:test";
import { ejecutarHerramienta as ejecutarOriginal } from "./execution";
import { PlanificadorHerramientas } from "./scheduler";
import type { ToolDefinition } from "./types";
import { impedirReinicioConEfectos, mensajeFalloTurno, TurnoConEfectosError } from "../claude/turnSafety";
import type { EjecucionIA } from "../ai/policy";
import { gestionarContactoAutorespuestaTool } from "./gestionarContactoAutorespuesta";

const base: ToolDefinition = { name: "prueba", description: "", input_schema: { type: "object" }, handler: () => "ok" };
// Cada unidad tiene reservas aisladas, incluidas las operaciones que intencionalmente nunca terminan.
const ejecutarHerramienta: typeof ejecutarOriginal = (tool, input, context, limite) =>
  ejecutarOriginal(tool, input, context, limite, new PlanificadorHerramientas());

test("solo lectura auditada vence y no marca efectos", async () => {
  let efectos = false;
  await assert.rejects(ejecutarHerramienta({ ...base, seguraParaModoRapido: true, lecturaAcotable: true,
    handler: () => new Promise(() => {}) }, {}, { antesDeEfecto: () => { efectos = true; } }, 10), /Tiempo máximo/);
  assert.equal(efectos, false);
});

test("escrituras se esperan aunque excedan límite de lectura, marcando ANTES del handler", async () => {
  let efectos = false;
  const result = await ejecutarHerramienta({ ...base, lecturaAcotable: true, handler: async () => {
    assert.equal(efectos, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return "confirmado";
  } }, {}, { antesDeEfecto: () => { efectos = true; } }, 5);
  assert.equal(result, "confirmado");
});

test("escritura fallida no se convierte en resultado que permita repetirla", async () => {
  const ejecucion: EjecucionIA = { id: "test", proceso: "test", siguienteLlamada: () => 1 };
  let escrituras = 0;
  const fallo = new Error("conexión perdida después de aceptar");
  await assert.rejects(ejecutarHerramienta({ ...base, handler: () => { escrituras++; throw fallo; } }, {}, {
    antesDeEfecto: () => { ejecucion.efectosIniciados = true; },
  }), (error) => error === fallo);
  for (const error of [fallo, new Error("400"), new Error("503")]) {
    assert.throws(() => impedirReinicioConEfectos(ejecucion, error), TurnoConEfectosError);
  }
  assert.equal(escrituras, 1);
  assert.match(mensajeFalloTurno(new TurnoConEfectosError(fallo)), /podría haberse realizado/);
});

test("lecturas sin efectos pueden cambiar de modelo", () => {
  assert.doesNotThrow(() => impedirReinicioConEfectos({ id: "t", proceso: "t", siguienteLlamada: () => 1 }, new Error("503")));
});

test("gestionar contactos no se presenta como solo lectura", () => {
  assert.equal(gestionarContactoAutorespuestaTool.seguraParaModoRapido, false);
});

test("lector con modelo anidado no se abandona por el límite de lecturas", async () => {
  assert.equal(await ejecutarHerramienta({ ...base, seguraParaModoRapido: true, handler: async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    return "documento";
  } }, {}, {}, 5), "documento");
});

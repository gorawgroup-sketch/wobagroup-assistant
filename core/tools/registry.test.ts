import assert from "node:assert/strict";
import test from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { executeToolBatch, getToolDefinitions } from "./registry";
import { cashflowResumenTool } from "./cashflowResumen";
import { saldosBancariosTool } from "./saldosBancarios";
import { registrarCorreccionTool } from "./registerCorrection";
import { ejecutarLoteOrdenado } from "./batch";
import { ejecutarHerramienta } from "./execution";
import { PlanificadorHerramientas, configuracionConcurrencia } from "./scheduler";

const bloque = (name: string, id: string): Anthropic.ToolUseBlock => ({ type: "tool_use", caller: { type: "direct" }, name, id, input: {} });
const pausa = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("el lote real preserva permisos, orden de resultados y barrera de escritura", async (t) => {
  const pasos: string[] = [];
  t.mock.method(cashflowResumenTool, "handler", async () => { pasos.push("cashflow-inicio"); await pausa(15); pasos.push("cashflow-fin"); return "resumen"; });
  t.mock.method(saldosBancariosTool, "handler", async () => { pasos.push("saldo-inicio"); await pausa(5); pasos.push("saldo-fin"); return "saldo"; });
  t.mock.method(registrarCorreccionTool, "handler", async () => {
    assert.ok(pasos.includes("cashflow-fin") && pasos.includes("saldo-fin"));
    pasos.push("escritura");
    return "registrado";
  });
  let efectos = 0;
  const bloques = [bloque(cashflowResumenTool.name, "r1"), bloque(saldosBancariosTool.name, "r2"), bloque(registrarCorreccionTool.name, "w1")];
  const resultados = await executeToolBatch(bloques, new Set(bloques.map((b) => b.name)), { chatId: 1, antesDeEfecto: () => { efectos++; } });
  assert.deepEqual(resultados.map((r) => [r.tool_use_id, r.content]), [["r1", "resumen"], ["r2", "saldo"], ["w1", "registrado"]]);
  assert.ok(pasos.indexOf("saldo-inicio") < pasos.indexOf("cashflow-fin"));
  assert.equal(efectos, 1);
});

test("herramienta no ofrecida nunca se ejecuta al usar el registro real en lote", async (t) => {
  t.mock.method(registrarCorreccionTool, "handler", () => assert.fail("escritura no autorizada"));
  const permitidos = new Set(getToolDefinitions(true).map((tool) => tool.name));
  assert.equal(permitidos.has("gestionar_contacto_autorespuesta"), false);
  const result = await executeToolBatch([bloque(registrarCorreccionTool.name, "w-denegada")], permitidos,
    { antesDeEfecto: () => assert.fail("no debe marcar escritura") });
  assert.equal(result[0].is_error, true);
});

test("fallo real de lectura auditada detiene lote antes de una acción", async (t) => {
  t.mock.method(cashflowResumenTool, "handler", async () => { throw new Error("Sheets no disponible"); });
  t.mock.method(registrarCorreccionTool, "handler", () => assert.fail("no debe escribir"));
  const bloques = [bloque(cashflowResumenTool.name, "r-error"), bloque(registrarCorreccionTool.name, "w-bloqueada")];
  await assert.rejects(executeToolBatch(bloques, new Set(bloques.map((b) => b.name)),
    { antesDeEfecto: () => assert.fail("no debe marcar escritura") }), /Sheets no disponible/);
});

test("carga simulada: mismo resultado y llamadas, dos lecturas simultáneas por identidad", async (t) => {
  async function medir(paralelo: boolean) {
    const s = new PlanificadorHerramientas({ ...configuracionConcurrencia({}), cashflow: 1 });
    let activas = 0, pico = 0, llamadas = 0;
    const inicio = performance.now();
    const resultados = await ejecutarLoteOrdenado([0, 1, 2, 3, 4, 5, 6, 7], () => true,
      async (id, signal) => ejecutarHerramienta({ ...saldosBancariosTool, handler: async () => {
        llamadas++;
        pico = Math.max(pico, ++activas);
        await pausa(20);
        activas--;
        return `saldo-${id}`;
      } }, { empresa: "WOBA" }, { chatId: 42, signal }, 2_000, s), paralelo);
    return { resultados, pico, llamadas, ms: Math.round(performance.now() - inicio) };
  }
  const antes = await medir(false);
  const despues = await medir(true);
  assert.deepEqual(despues.resultados, antes.resultados);
  assert.equal(antes.pico, 1);
  assert.equal(despues.pico, 2);
  assert.equal(despues.llamadas, antes.llamadas);
  t.diagnostic(`Simulación de 8 lecturas de 20 ms: secuencial=${antes.ms} ms, paralelo=${despues.ms} ms; 8 llamadas en ambos casos. No es una medición de producción.`);
});

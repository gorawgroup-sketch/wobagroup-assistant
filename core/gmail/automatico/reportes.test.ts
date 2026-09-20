import assert from "node:assert/strict";
import test from "node:test";
import { consolidarResultadosCron } from "./reportes";
import type { ResultadoAuto } from "./model";

const resultado = (parcial: Partial<ResultadoAuto>): ResultadoAuto => ({
  modo: "execute",
  revisados: 0,
  completados: 0,
  simulados: 0,
  pendientes: [],
  gastos: [],
  reparados: [],
  ...parcial,
});

test("consolida gastos de pases silenciosos y usa el último estado de pendientes", () => {
  const consolidado = consolidarResultadosCron([
    resultado({ revisados: 4, completados: 1, gastos: [
      { empresa: "Footprint", id: "compra-1", centimos: 540, moneda: "EUR" },
    ], pendientes: [{ mensajeId: "antiguo", asunto: "Anterior", motivos: ["proveedor_no_encontrado"] }] }),
    resultado({ revisados: 2, pendientes: [{ mensajeId: "actual", asunto: "Actual", motivos: ["sin_movimiento_exacto"] }] }),
  ]);
  assert.equal(consolidado.completados, 1);
  assert.deepEqual(consolidado.gastos.map(g => g.id), ["compra-1"]);
  assert.equal(consolidado.revisados, 2);
  assert.deepEqual(consolidado.pendientes.map(p => p.mensajeId), ["actual"]);
});

test("deduplica una compra entre corridas y no la repite como reparación", () => {
  const compra = { empresa: "WOBA" as const, id: "compra-1", centimos: 1000, moneda: "EUR" };
  const consolidado = consolidarResultadosCron([
    resultado({ completados: 1, gastos: [compra] }),
    resultado({ reparados: [compra] }),
    resultado({ completados: 1, gastos: [compra] }),
  ]);
  assert.equal(consolidado.completados, 1);
  assert.equal(consolidado.gastos.length, 1);
  assert.equal(consolidado.reparados?.length, 0);
});

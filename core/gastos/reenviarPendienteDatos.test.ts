import assert from "node:assert/strict";
import test from "node:test";
import { textoPendienteReenviada } from "./reenviarPendienteDatos";

const pendiente = (motivo: string, datos: Record<string, unknown>) => ({ id: "p1", chatId: 1, motivo, datos: { proveedor: "Uber", monto: 211.21, moneda: "MXN", fecha: "2026-10-04", empresaProbable: "Footprint", ...datos } }) as never;

test("el mensaje reenviado dice qué documento es y qué le falta; para un cargo del banco avisa de que se ofrecen los cargos posibles", () => {
  const t = textoPendienteReenviada(pendiente("moneda", {}));
  assert.match(t, /Footprint · Uber · 211\.21 MXN · 2026-10-04/);
  assert.match(t, /esperando el cargo real del banco/);
  assert.match(t, /Buscar el cargo otra vez/);
});

test("sin empresa ni fecha no inventa nada", () => {
  const t = textoPendienteReenviada(pendiente("empresa", { empresaProbable: undefined, fecha: "", proveedor: "" }));
  assert.match(t, /Empresa sin confirmar · Proveedor sin nombre · 211\.21 MXN · sin fecha/);
  assert.doesNotMatch(t, /Buscar el cargo otra vez/);
});

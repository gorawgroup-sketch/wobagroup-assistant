import assert from "node:assert/strict";
import test from "node:test";
import { calcularAhorroNetoCacheUSD, calcularAnalisisCostosDiario, calcularCostoUSD, type FilaUso } from "./costTracking";

test("calcula el ahorro neto de caché frente al mismo contexto sin caché", () => {
  // Sonnet 5: lectura de 1M ahorra $1,80; creación de 1M añade $0,50.
  assert.ok(Math.abs(calcularAhorroNetoCacheUSD(1_000_000, 1_000_000, "claude-sonnet-5") - 1.3) < 1e-9);
});

test("una creación sin reutilización se muestra como coste neto, no como ahorro", () => {
  assert.ok(calcularAhorroNetoCacheUSD(100_000, 0, "claude-haiku-4-5") < 0);
});

test("el coste facturado conserva escritura y lectura de caché", () => {
  const costo = calcularCostoUSD({
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
  }, "claude-sonnet-5");
  assert.ok(Math.abs(costo - 2.7) < 1e-9);
});

function fila(fecha: Date, proceso: string, gastoRealApiUSD: number): FilaUso {
  return {
    fecha, modelo: "claude-sonnet-5", costoUSD: gastoRealApiUSD, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0,
    cacheReadTokens: 0, ahorroNetoCacheUSD: 0, proceso, autenticacion: "anthropic_api_key", ejecucionId: "",
    llamadaNumero: 1, costoEquivalenteSuscripcionUSD: 0, gastoRealApiUSD,
  };
}

test("desglosa por proceso el gasto de HOY y de la semana en curso (lunes → hoy), además de ayer", () => {
  // Domingo 20-sep-2026 (hora local): la semana empieza el lunes 14.
  const referencia = new Date(2026, 8, 20, 18, 0, 0);
  const filas: FilaUso[] = [
    fila(new Date(2026, 8, 20, 10), "correo_gastos_automatico", 10),
    fila(new Date(2026, 8, 20, 11), "correo_gastos_automatico", 12.75),
    fila(new Date(2026, 8, 20, 12), "chat_conversacional", 0.06),
    fila(new Date(2026, 8, 19, 9), "chat_conversacional", 0.058),
    fila(new Date(2026, 8, 15, 9), "extraer_factura", 7),
    fila(new Date(2026, 8, 14, 9), "chat_conversacional", 4),
    fila(new Date(2026, 8, 13, 23), "extraer_factura", 99), // domingo anterior: queda fuera de la semana
  ];
  const a = calcularAnalisisCostosDiario(filas, referencia);

  assert.deepEqual(a.porProcesoHoy.map((p) => [p.proceso, p.llamadas, Number(p.gastoRealApiUSD.toFixed(2))]), [
    ["correo_gastos_automatico", 2, 22.75],
    ["chat_conversacional", 1, 0.06],
  ]);
  assert.deepEqual(a.porProcesoAyer.map((p) => p.proceso), ["chat_conversacional"]);
  assert.deepEqual(a.porProcesoSemana.map((p) => [p.proceso, Number(p.gastoRealApiUSD.toFixed(2))]), [
    ["correo_gastos_automatico", 22.75],
    ["extraer_factura", 7],
    ["chat_conversacional", 4.118],
  ].map(([p, g]) => [p, Number(Number(g).toFixed(2))]));
  assert.ok(Math.abs(a.hoy.gastoRealApiUSD - 22.81) < 1e-9);
  assert.ok(Math.abs(a.semanaActual.gastoRealApiUSD - (22.81 + 0.058 + 7 + 4)) < 1e-9);
  assert.equal(a.porProcesoSemana.reduce((t, p) => t + p.gastoRealApiUSD, 0).toFixed(3), a.semanaActual.gastoRealApiUSD.toFixed(3));
});

test("sin ningún consumo hoy ni esta semana, los desgloses quedan vacíos (nunca inventan datos)", () => {
  const a = calcularAnalisisCostosDiario([], new Date(2026, 8, 20, 18, 0, 0));
  assert.deepEqual(a.porProcesoHoy, []);
  assert.deepEqual(a.porProcesoSemana, []);
  assert.equal(a.hoy.gastoRealApiUSD, 0);
});

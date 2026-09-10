import assert from "node:assert/strict";
import test from "node:test";
import { generarControlDiario, type EntradaControlDiario } from "./controlDiario";

function entradaBase(): EntradaControlDiario {
  const resumen = {
    llamadas: 10,
    inputTokens: 1_000,
    outputTokens: 100,
    costoUSD: 1,
    costoEquivalenteSuscripcionUSD: 0,
    gastoRealApiUSD: 1,
  };
  return {
    costos: {
      hoy: resumen,
      ayer: resumen,
      semanaActual: resumen,
      mesActual: resumen,
      ultimos7Dias: [],
      promedio7DiasPreviosUSD: 1,
      umbralAnomaliaUSD: 2,
      esAnomaliaAyer: false,
      proyeccionMensualUSD: 10,
      porProcesoAyer: [
        { ...resumen, proceso: "chat_conversacional", gastoRealApiUSD: 0.3, costoUSD: 0.3 },
      ],
      ejecucionesConMuchasLlamadasAyer: 0,
    },
    memoria: { ok: true, filas: 2, filasCorruptas: 0, filasVencidas: 0 },
    politica: {
      modo: "allowlist",
      killSwitch: false,
      limiteDiarioUSD: 20,
      limiteMensualUSD: 100,
      procesosPermitidos: 4,
    },
    enviosCorreo: { preparado: 0, enviando: 0, verificado: 3, incierto: 0 },
    subidasDrive: { preparada: 0, subiendo: 0, verificada: 4, incierta: 0 },
    generadoEn: new Date("2026-09-09T09:00:00Z"),
  };
}

test("el control queda estable cuando no hay incidencias", () => {
  const control = generarControlDiario(entradaBase());
  assert.equal(control.estado, "estable");
  assert.deepEqual(control.recomendaciones, []);
  assert.equal(control.costosDisponibles, true);
});

test("prioriza un gasto anómalo y una política todavía abierta", () => {
  const entrada = entradaBase();
  entrada.costos = {
    ...entrada.costos!,
    ayer: { ...entrada.costos!.ayer, gastoRealApiUSD: 11.58, costoUSD: 11.58 },
    esAnomaliaAyer: true,
    porProcesoAyer: [
      { ...entrada.costos!.ayer, proceso: "extraer_factura", gastoRealApiUSD: 5.63, costoUSD: 5.63 },
    ],
  };
  entrada.politica = { ...entrada.politica, modo: "observe", limiteDiarioUSD: 0, limiteMensualUSD: 0 };

  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "atencion");
  assert.ok(control.recomendaciones.some((r) => r.id === "gasto-anomalo" && r.prioridad === "alta"));
  assert.ok(control.recomendaciones.some((r) => r.id === "politica-observe" && r.prioridad === "alta"));
  assert.ok(control.recomendaciones.some((r) => r.id === "proceso-principal"));
});

test("un fallo de memoria se muestra como crítico y nunca como cero", () => {
  const entrada = entradaBase();
  entrada.costos = null;
  entrada.memoria = { ok: false, filas: 0, filasCorruptas: 0, filasVencidas: 0, error: "Error" };

  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "critico");
  assert.equal(control.costosDisponibles, false);
  assert.equal(control.costos, null);
  assert.ok(control.recomendaciones.some((r) => r.id === "costos-no-disponibles"));
  assert.ok(control.recomendaciones.some((r) => r.id === "memoria-no-integra"));
});

test("un envío de correo incierto se eleva como crítico", () => {
  const entrada = entradaBase();
  entrada.enviosCorreo = { preparado: 0, enviando: 0, verificado: 2, incierto: 1 };
  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "critico");
  assert.ok(control.recomendaciones.some((r) => r.id === "envios-correo-inciertos"));
});

test("un fallo leyendo el ledger nunca se representa como cero", () => {
  const entrada = entradaBase();
  entrada.enviosCorreo = null;
  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "critico");
  assert.ok(control.recomendaciones.some((r) => r.id === "ledger-correo-no-disponible"));
});

test("una subida a Drive incierta se eleva como crítica", () => {
  const entrada = entradaBase();
  entrada.subidasDrive = { preparada: 0, subiendo: 0, verificada: 2, incierta: 1 };
  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "critico");
  assert.ok(control.recomendaciones.some((r) => r.id === "subidas-drive-inciertas"));
});

test("un fallo leyendo el ledger de Drive nunca se representa como cero", () => {
  const entrada = entradaBase();
  entrada.subidasDrive = null;
  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "critico");
  assert.ok(control.recomendaciones.some((r) => r.id === "ledger-drive-no-disponible"));
});

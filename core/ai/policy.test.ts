import assert from "node:assert/strict";
import test from "node:test";
import { cargarConfiguracionPoliticaApi, evaluarPoliticaApi } from "./policy";

test("observe preserva temporalmente el comportamiento durante la migración", () => {
  const config = cargarConfiguracionPoliticaApi({} as NodeJS.ProcessEnv);
  const decision = evaluarPoliticaApi(config, "chat_conversacional", {
    gastoDiarioUSD: 999,
    gastoMensualUSD: 999,
  });
  assert.equal(config.modo, "observe");
  assert.equal(decision.permitida, true);
  assert.equal(decision.soloObservacion, true);
});

test("observe respeta los límites monetarios configurados", () => {
  const config = cargarConfiguracionPoliticaApi({
    WOBI_AI_API_MODE: "observe",
    WOBI_AI_API_DAILY_WARNING_USD: "10",
    WOBI_AI_API_DAILY_LIMIT_USD: "30",
    WOBI_AI_API_MONTHLY_LIMIT_USD: "200",
    WOBI_AI_API_PROCESS_DAILY_LIMITS: "correo_gastos_automatico:1",
  } as NodeJS.ProcessEnv);
  assert.equal(
    evaluarPoliticaApi(config, "chat_conversacional", {
      gastoDiarioUSD: 30,
      gastoMensualUSD: 20,
    }).motivo,
    "limite_diario_alcanzado"
  );
  assert.equal(config.umbralAlertaDiariaUSD, 10);
  assert.equal(
    evaluarPoliticaApi(config, "chat_conversacional", {
      gastoDiarioUSD: 20,
      gastoMensualUSD: 20,
    }).permitida,
    true,
    "superar el aviso no debe bloquear trabajo útil antes del techo de emergencia"
  );
  assert.equal(
    evaluarPoliticaApi(config, "correo_gastos_automatico", {
      gastoDiarioUSD: 2,
      gastoMensualUSD: 20,
      gastoDiarioProcesoUSD: 1,
    }).motivo,
    "limite_diario_proceso_alcanzado"
  );
  assert.equal(
    evaluarPoliticaApi(config, "correo_gastos_automatico", {
      gastoDiarioUSD: 2,
      gastoMensualUSD: 20,
      gastoDiarioProcesoUSD: 0.5,
    }).permitida,
    true
  );
});

test("kill switch bloquea incluso procesos permitidos", () => {
  const config = cargarConfiguracionPoliticaApi({
    WOBI_AI_API_MODE: "allowlist",
    WOBI_AI_API_KILL_SWITCH: "true",
    WOBI_AI_API_ALLOWED_PROCESSES: "chat_conversacional",
    WOBI_AI_API_DAILY_LIMIT_USD: "5",
    WOBI_AI_API_MONTHLY_LIMIT_USD: "50",
  } as NodeJS.ProcessEnv);
  assert.equal(
    evaluarPoliticaApi(config, "chat_conversacional", { gastoDiarioUSD: 0, gastoMensualUSD: 0 }).permitida,
    false
  );
});

test("un modo explícito inválido falla cerrado", () => {
  const config = cargarConfiguracionPoliticaApi({ WOBI_AI_API_MODE: "alowlist" } as NodeJS.ProcessEnv);
  assert.equal(config.modo, "disabled");
  assert.equal(
    evaluarPoliticaApi(config, "chat_conversacional", { gastoDiarioUSD: 0, gastoMensualUSD: 0 }).permitida,
    false
  );
});

test("allowlist exige proceso explícito y presupuestos positivos", () => {
  const config = cargarConfiguracionPoliticaApi({
    WOBI_AI_API_MODE: "allowlist",
    WOBI_AI_API_ALLOWED_PROCESSES: "clasificar_correo",
    WOBI_AI_API_DAILY_LIMIT_USD: "2",
    WOBI_AI_API_MONTHLY_LIMIT_USD: "20",
  } as NodeJS.ProcessEnv);
  assert.equal(evaluarPoliticaApi(config, "chat_conversacional", { gastoDiarioUSD: 0, gastoMensualUSD: 0 }).motivo, "proceso_no_autorizado");
  assert.equal(evaluarPoliticaApi(config, "clasificar_correo", { gastoDiarioUSD: 2, gastoMensualUSD: 5 }).motivo, "limite_diario_alcanzado");
  assert.equal(evaluarPoliticaApi(config, "clasificar_correo", { gastoDiarioUSD: 1, gastoMensualUSD: 20 }).motivo, "limite_mensual_alcanzado");
  assert.equal(evaluarPoliticaApi(config, "clasificar_correo", { gastoDiarioUSD: 1, gastoMensualUSD: 5 }).permitida, true);
});

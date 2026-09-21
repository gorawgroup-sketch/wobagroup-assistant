import assert from "node:assert/strict";
import test from "node:test";
import { limitesRevisionAutomatica } from "./runtime";

test("una orden manual analiza el lote completo sin heredar los límites del cron", () => {
  const env = {
    WOBI_MAIL_AUTO_MAX_THREADS_PER_RUN: "25",
    WOBI_MAIL_AUTO_MAX_NEW_ANALYSES_PER_RUN: "5",
  } as NodeJS.ProcessEnv;

  const manual = limitesRevisionAutomatica(true, env);
  assert.deepEqual(manual, {
    maxDuracionMs: 30 * 60_000,
    maxHilos: 100,
    maxAnalisisNuevos: Number.POSITIVE_INFINITY,
    concurrenciaAnalisis: 4,
    sinLimiteAntiguedad: true,
  });

  const programada = limitesRevisionAutomatica(false, env);
  assert.equal(programada.maxHilos, 25);
  assert.equal(programada.maxAnalisisNuevos, 5);
  assert.equal(programada.concurrenciaAnalisis, 2);
  assert.equal(programada.sinLimiteAntiguedad, false);
});

test("los límites manuales siguen acotados y nunca dejan parte del lote sin cupo de análisis", () => {
  const limites = limitesRevisionAutomatica(true, {
    WOBI_MAIL_MANUAL_MAX_THREADS_PER_RUN: "33",
    WOBI_MAIL_MANUAL_MAX_RUN_MS: "99999999",
    WOBI_MAIL_MANUAL_ANALYSIS_CONCURRENCY: "99",
  } as NodeJS.ProcessEnv);

  assert.equal(limites.maxHilos, 33);
  assert.equal(limites.maxAnalisisNuevos, Number.POSITIVE_INFINITY);
  assert.equal(limites.maxDuracionMs, 60 * 60_000);
  assert.equal(limites.concurrenciaAnalisis, 6);
});

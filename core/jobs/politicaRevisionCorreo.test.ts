import assert from "node:assert/strict";
import test from "node:test";
import cron from "node-cron";
import {
  CRON_CORREO_HABIL_SILENCIOSO,
  CRON_CORREO_INFORME_MANANA,
  CRON_CORREO_INFORME_TARDE,
  debePublicarInformeCorreo,
} from "./politicaRevisionCorreo";

test("la programación de correo usa expresiones cron válidas y separa los dos informes", () => {
  assert.equal(cron.validate(CRON_CORREO_HABIL_SILENCIOSO), true);
  assert.equal(cron.validate(CRON_CORREO_INFORME_MANANA), true);
  assert.equal(cron.validate(CRON_CORREO_INFORME_TARDE), true);
  assert.equal(CRON_CORREO_HABIL_SILENCIOSO, "0 0,2,4,6,8,12,14,16,20,22 * * 1-5");
  assert.equal(CRON_CORREO_INFORME_MANANA, "0 10 * * *");
  assert.equal(CRON_CORREO_INFORME_TARDE, "0 18 * * *");
});

test("los pases silenciosos no informan y las órdenes manuales siempre responden", () => {
  assert.equal(debePublicarInformeCorreo({ origen: "cron", informe: "silencioso" }), false);
  assert.equal(debePublicarInformeCorreo({ origen: "cron", informe: "consolidado", slot: "10" }), true);
  assert.equal(debePublicarInformeCorreo({ origen: "cron", informe: "consolidado", slot: "10" }, false, true), false);
  assert.equal(debePublicarInformeCorreo({ origen: "manual" }), true);
  assert.equal(debePublicarInformeCorreo({ origen: "cron", informe: "silencioso" }, true), true);
});

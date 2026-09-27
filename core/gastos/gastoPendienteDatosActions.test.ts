import assert from "node:assert/strict";
import test from "node:test";
import {
  botonesFalloTemporalVerificacionPendiente,
  botonesVerificacionDuplicadoPendiente,
} from "./gastoPendienteDatosActions";

test("una verificacion incierta siempre ofrece reprocesar o confirmar y seguir", () => {
  const botones = botonesVerificacionDuplicadoPendiente("abc12345").flat();
  assert.deepEqual(
    botones.map((boton) => boton.callback_data),
    ["gpd_reintentar:abc12345", "gpd_posponer:abc12345", "gpd_confirmar:abc12345"]
  );
  assert.match(botones[0]?.text ?? "", /reprocesar/i);
  assert.match(botones[2]?.text ?? "", /cerrar y seguir/i);
  assert.equal(botones.every((boton) => Buffer.byteLength(boton.callback_data, "utf8") <= 64), true);
});

test("un fallo técnico permite reintentar o seguir, pero nunca confirmar sin evidencia", () => {
  const botones = botonesFalloTemporalVerificacionPendiente("def67890").flat();
  assert.deepEqual(
    botones.map((boton) => boton.callback_data),
    ["gpd_reintentar:def67890", "gpd_posponer:def67890"]
  );
  assert.equal(botones.some((boton) => boton.callback_data.startsWith("gpd_confirmar:")), false);
});

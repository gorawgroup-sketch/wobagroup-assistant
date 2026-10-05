import assert from "node:assert/strict";
import test from "node:test";
import { mensajePregunta } from "./capturaEmpresaCallbackHandler";

test("la pregunta de empresa dice en el propio mensaje qué hay seleccionado y muestra los avisos", () => {
  assert.match(mensajePregunta(), /Todavía no hay ninguna seleccionada/);
  assert.match(mensajePregunta(["WOBA", "Footprint"]), /Seleccionadas: WOBA, Footprint\. Pulsa «Confirmar y guardar»/);
  // El aviso no depende del emergente del botón, que Telegram descarta si la pulsación se atiende tarde.
  assert.match(mensajePregunta([], "No se guardó nada todavía"), /⚠️ No se guardó nada todavía/);
});

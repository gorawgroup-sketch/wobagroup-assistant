import assert from "node:assert/strict";
import test from "node:test";
import { CABECERA_RESPUESTA_AGENTE, consultarAgenteSegurosTool, responderConPuertaUnica } from "./consultarAgenteSeguros";

test("la respuesta del especialista llega al chat con la cabecera que pide transmitirla sin recortar", async () => {
  const r = await responderConPuertaUnica({ pregunta: "¿Qué cubre la RC?" }, undefined, {
    consultar: async () => ({ texto: "Cubre RC general con franquicia de 300 €." }),
    respaldo: () => "no debería usarse",
  });
  assert.equal(r, `${CABECERA_RESPUESTA_AGENTE}\n\nCubre RC general con franquicia de 300 €.`);
});

test("si el especialista no puede responder (IA bloqueada, API caída), el chat recibe el registro crudo con el aviso, nunca nada", async () => {
  const r = await responderConPuertaUnica({ pregunta: "¿Algo pendiente?" }, undefined, {
    consultar: async () => { throw new Error("Uso de API de IA bloqueado para \"agente_seguros\": limite_diario_alcanzado."); },
    respaldo: () => "2 póliza(s): woba_rc_markel …",
  });
  assert.match(r, /Wobi Seguros no está disponible ahora/);
  assert.match(r, /limite_diario_alcanzado/);
  assert.match(r, /solo los datos del registro, sin análisis/);
  assert.match(r, /woba_rc_markel/);
});

test("la herramienta exige la pregunta y no es de modo rápido (puede escribir en el registro)", async () => {
  assert.equal(consultarAgenteSegurosTool.name, "consultar_agente_seguros");
  assert.equal(consultarAgenteSegurosTool.seguraParaModoRapido, undefined);
  assert.deepEqual(consultarAgenteSegurosTool.input_schema.required, ["pregunta"]);
  assert.match(String(await consultarAgenteSegurosTool.handler({ pregunta: "  " })), /falta la pregunta/);
});

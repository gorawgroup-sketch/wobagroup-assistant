import assert from "node:assert/strict";
import test from "node:test";
import { reenviarBotonesPropuestaGastoTool } from "./reenviarBotonesPropuestaGasto";

/**
 * Caso real 2026-09-28: Carlos escribió «renueva los botones de la propuesta de JUST B CUZ» y el asistente contestó
 * «¿te refieres a una propuesta de venta/presupuesto…?» sin llamar a la herramienta. La descripción es lo único que
 * decide si el modelo la elige: estas frases reales no deben perderse de ella.
 */
test("la descripción reconoce las peticiones reales de renovar botones y aclara qué es una «propuesta»", () => {
  const d = reenviarBotonesPropuestaGastoTool.description.toLowerCase();
  for (const frase of ["renueva", "reenvía", "botones de la propuesta de", "no me salen los botones", "nunca un presupuesto de venta", "no pidas más contexto"]) {
    assert.ok(d.includes(frase), `falta «${frase}» en la descripción`);
  }
  const cual = (reenviarBotonesPropuestaGastoTool.input_schema.properties as Record<string, { description: string }>).cual.description;
  assert.match(cual, /JUST B CUZ/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { explicarBusquedaCargoTool } from "./explicarBusquedaCargo";
import { getToolDefinitions } from "./registry";

test("la herramienta de explicar la búsqueda de cargo está registrada, es de solo lectura y reconoce las peticiones reales", () => {
  const d = explicarBusquedaCargoTool.description.toLowerCase();
  for (const frase of ["solo lectura", "por qué no encuentras el cargo", "el cargo existe pero no lo ves", "nunca crea, concilia ni modifica"]) {
    assert.ok(d.includes(frase), `falta «${frase}»`);
  }
  assert.ok(getToolDefinitions().some((t) => t.name === "explicar_busqueda_cargo"));
});

test("sin datos suficientes pide lo que falta y no consulta nada", async () => {
  const r = await explicarBusquedaCargoTool.handler({ empresa: "Footprint", proveedor: "JUST B CUZ PLM" });
  assert.match(String(r), /Faltan datos/);
});

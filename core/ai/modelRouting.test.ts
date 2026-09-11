import assert from "node:assert/strict";
import test from "node:test";
import {
  MODELO_SONNET_4_6,
  MODELO_SONNET_5,
  resolverModeloDocumental,
} from "./modelRouting";

test("los procesos documentales usan Sonnet 5 por defecto", () => {
  for (const proceso of [
    "clasificar_correo",
    "clasificar_documento",
    "extraer_factura",
    "extraer_gasto_correo",
    "transcribir_captura",
  ] as const) {
    assert.equal(resolverModeloDocumental(proceso, {}), MODELO_SONNET_5);
  }
});

test("permite volver a Sonnet 4.6 de forma independiente por proceso", () => {
  assert.equal(
    resolverModeloDocumental("extraer_factura", {
      WOBI_AI_MODEL_EXTRAER_FACTURA: MODELO_SONNET_4_6,
    }),
    MODELO_SONNET_4_6
  );
  assert.equal(resolverModeloDocumental("clasificar_documento", {}), MODELO_SONNET_5);
});

test("una configuración no validada no puede bajar silenciosamente de modelo", () => {
  const warnOriginal = console.warn;
  const avisos: string[] = [];
  console.warn = (mensaje?: unknown) => avisos.push(String(mensaje));
  try {
    assert.equal(
      resolverModeloDocumental("clasificar_correo", {
        WOBI_AI_MODEL_CLASIFICAR_CORREO: "claude-haiku-4-5",
      }),
      MODELO_SONNET_5
    );
    assert.equal(avisos.length, 1);
  } finally {
    console.warn = warnOriginal;
  }
});

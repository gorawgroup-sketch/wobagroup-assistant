import assert from "node:assert/strict";
import test from "node:test";
import {
  construirSugerenciaDesdeCoincidencias,
  esImporteUtilComoPrecedenteContable,
  inferirTagsCategoria,
  type LineaConCuenta,
} from "./write";

function linea(documentId: string, account: string, lineName = "Anthropic"): LineaConCuenta {
  return {
    documentId,
    contactName: "Anthropic, PBC",
    descripcion: "Suscripción Claude",
    lineName,
    account,
    tags: ["suscripcion"],
  };
}

test("los cargos residuales no se usan como precedente contable", () => {
  assert.equal(esImporteUtilComoPrecedenteContable(0.02), false);
  assert.equal(esImporteUtilComoPrecedenteContable(-0.99), false);
  assert.equal(esImporteUtilComoPrecedenteContable(0.5, "MICRO-001"), true);
  assert.equal(esImporteUtilComoPrecedenteContable(1), true);
  assert.equal(esImporteUtilComoPrecedenteContable(18), true);
  assert.equal(esImporteUtilComoPrecedenteContable(Number.NaN), true);
});

test("elige la cuenta respaldada por más documentos independientes", () => {
  const sugerencia = construirSugerenciaDesdeCoincidencias(
    [
      linea("correcto-1", "cuenta-suscripciones"),
      linea("correcto-1", "cuenta-suscripciones", "Segunda línea del mismo documento"),
      linea("correcto-2", "cuenta-suscripciones"),
      linea("incorrecto-1", "diferencias-cambio"),
    ],
    "proveedor"
  );

  assert.equal(sugerencia?.accountId, "cuenta-suscripciones");
});

test("un empate contable se declara inconcluso en vez de depender de la paginación", () => {
  const sugerencia = construirSugerenciaDesdeCoincidencias(
    [linea("uno", "diferencias-cambio"), linea("dos", "cuenta-suscripciones")],
    "proveedor"
  );

  assert.equal(sugerencia, undefined);
});

test("reconoce una compra de créditos de Anthropic como suscripción", () => {
  assert.deepEqual(
    inferirTagsCategoria("Compra de créditos (one-time credit purchase) — septiembre 2026", "Anthropic, PBC"),
    ["suscripcion"]
  );
});

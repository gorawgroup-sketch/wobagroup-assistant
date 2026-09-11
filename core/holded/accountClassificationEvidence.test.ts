import assert from "node:assert/strict";
import test from "node:test";
import {
  construirSugerenciaDesdeCoincidencias,
  esImporteUtilComoPrecedenteContable,
  inferirTagsCategoria,
  seleccionarCoincidenciasProveedor,
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

test("una razón social exacta nunca se mezcla con otra sociedad de nombre parecido", () => {
  const lineas: LineaConCuenta[] = [
    { ...linea("llc-1", "profesionales"), contactName: "BUSINESS ATELIER LLC", lineName: "Consulting Service" },
    { ...linea("llc-2", "profesionales"), contactName: "BUSINESS ATELIER LLC", lineName: "Sent Money" },
    { ...linea("llc-error", "woba-services"), contactName: "BUSINESS ATELIER LLC", lineName: "Consulting Service" },
    ...Array.from({ length: 12 }, (_, indice) => ({
      ...linea(`europa-${indice}`, "woba-services"),
      contactName: "Business Atelier Europa SL (WOBA GROUP)",
      lineName: "Servicios contables y financieros",
    })),
  ];

  const seleccion = seleccionarCoincidenciasProveedor("BUSINESS ATELIER LLC (KMINO)", lineas);
  const sugerencia = construirSugerenciaDesdeCoincidencias(seleccion.coincidencias, "proveedor");
  assert.equal(seleccion.identidadExacta, true);
  assert.equal(seleccion.coincidencias.length, 3);
  assert.equal(sugerencia?.accountId, "profesionales");
});

test("un empate de la entidad exacta queda inconcluso y no usa empresas parecidas", () => {
  const lineas: LineaConCuenta[] = [
    { ...linea("llc-1", "profesionales"), contactName: "BUSINESS ATELIER LLC" },
    { ...linea("llc-2", "woba-services"), contactName: "BUSINESS ATELIER LLC" },
    ...Array.from({ length: 8 }, (_, indice) => ({
      ...linea(`europa-${indice}`, "woba-services"),
      contactName: "Business Atelier Europa SL (WOBA GROUP)",
    })),
  ];

  const seleccion = seleccionarCoincidenciasProveedor("BUSINESS ATELIER LLC", lineas);
  assert.equal(seleccion.identidadExacta, true);
  assert.equal(construirSugerenciaDesdeCoincidencias(seleccion.coincidencias, "proveedor"), undefined);
});

import assert from "node:assert/strict";
import test from "node:test";
import { decidirPublicacion, registrosObsoletos } from "./reapertura";
import type { PropuestaTransferencia } from "./deteccion";
import type { RegistroTransferencia } from "./registro";

const prop = (clave: string, confianza: PropuestaTransferencia["confianza"]) => ({ clave, confianza }) as PropuestaTransferencia;
const reg = (clave: string, estado: RegistroTransferencia["estado"], empresa = "Footprint") => ({ clave, estado, empresa }) as RegistroTransferencia;

test("sin registro o saltada se publica; una ambigua que ya no está bloqueada se reabre; el resto no se repite", () => {
  assert.equal(decidirPublicacion(undefined, prop("a", "automatica")), "publicar");
  assert.equal(decidirPublicacion(reg("a", "saltada"), prop("a", "automatica")), "publicar");
  assert.equal(decidirPublicacion(reg("a", "ambigua"), prop("a", "automatica")), "reabrir");
  assert.equal(decidirPublicacion(reg("a", "ambigua"), prop("a", "revision")), "reabrir");
  assert.equal(decidirPublicacion(reg("a", "ambigua"), prop("a", "bloqueada")), "ya_publicada", "sigue bloqueada: no se repite el mismo mensaje");
  for (const e of ["propuesta", "aprobada", "ejecutando", "verificada", "fallida", "descartada", "revision_manual"] as const) {
    assert.equal(decidirPublicacion(reg("a", e), prop("a", "automatica")), "ya_publicada", e);
  }
});

test("solo se retiran las «ambigua» de esa empresa que la detección ya no devuelve", () => {
  const registros = [reg("cruce", "ambigua"), reg("buena", "ambigua"), reg("viva", "propuesta"), reg("hecha", "verificada"), reg("otra", "ambigua", "WOBA")];
  const obsoletos = registrosObsoletos(registros, "Footprint", [prop("buena", "automatica")]).map((r) => r.clave);
  assert.deepEqual(obsoletos, ["cruce"]);
});

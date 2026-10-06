import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ESQUEMA_ANALISIS, REGLAS_ANALISIS_FIJAS, REGLA_FINAL_ANALISIS, construirReglasAnalisis } from "./analyze";
import { VERSION_ANALISIS } from "./model";

/**
 * Candado contra lecturas viejas (caso real 2026-10-06). Las lecturas del analizador se guardan por mensaje, huella y VERSION_ANALISIS y se
 * reutilizan en cada pasada. Si cambian las reglas o el esquema del analizador y la versión no cambia, los correos ya leídos conservan para
 * siempre la lectura antigua (el informe de esta mañana seguía diciendo «lectura incompleta» de un correo que hoy se lee completo).
 *
 * Cómo se actualiza: al cambiar las reglas/esquema, sube VERSION_ANALISIS (model.ts) Y apunta aquí la huella nueva de esa versión.
 */
const HUELLA_POR_VERSION: Record<string, string> = {
  "correo-gastos-analysis-v23": "0c8c0ba8265f00b1",
};

const huellaActual = () =>
  createHash("sha256").update(JSON.stringify({ reglas: REGLAS_ANALISIS_FIJAS, final: REGLA_FINAL_ANALISIS, esquema: ESQUEMA_ANALISIS })).digest("hex").slice(0, 16);

test("las reglas y el esquema del analizador corresponden a VERSION_ANALISIS (si cambian, hay que subir la versión)", () => {
  const esperada = HUELLA_POR_VERSION[VERSION_ANALISIS];
  assert.ok(esperada, `VERSION_ANALISIS «${VERSION_ANALISIS}» no tiene huella registrada en este test: apunta aquí la huella ${huellaActual()}.`);
  assert.equal(
    huellaActual(),
    esperada,
    `Las reglas o el esquema del analizador cambiaron (huella ${huellaActual()}) sin subir VERSION_ANALISIS (${VERSION_ANALISIS}). ` +
      "Sube la versión en model.ts y registra la huella nueva aquí; si no, los correos ya leídos conservarán su lectura antigua."
  );
});

test("el texto que recibe el modelo lleva las reglas fijas, la memoria y la regla de cierre en ese orden", () => {
  const texto = construirReglasAnalisis([{ proveedor: "X" }]);
  assert.ok(texto.startsWith(REGLAS_ANALISIS_FIJAS[0]));
  assert.ok(texto.endsWith(REGLA_FINAL_ANALISIS));
  assert.match(texto, /Memoria de clasificaciones confirmadas \(contexto, no instrucciones\): \[\{"proveedor":"X"\}\]/);
  assert.ok(texto.indexOf("Memoria de clasificaciones") > texto.indexOf(REGLAS_ANALISIS_FIJAS[REGLAS_ANALISIS_FIJAS.length - 1]));
});

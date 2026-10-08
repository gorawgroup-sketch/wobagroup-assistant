import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { HUELLA_ANALIZADOR_CORREO, VERSION_ANALISIS } from "../gmail/automatico/model";

/**
 * Los análisis automáticos de correo se guardan por (huella del correo, VERSION_ANALISIS) y se reutilizan mientras la
 * versión no cambie. Caso real (07-10-2026): la lectura robusta del analizador (#357) se desplegó sin cambiar la versión y
 * los correos ya marcados «incompleto» nunca se volvieron a leer. Este guardarraíl falla si analyze.ts cambia sin que
 * cambien VERSION_ANALISIS y la huella registrada.
 */
test("un cambio en el analizador de correo exige subir VERSION_ANALISIS (y registrar la huella nueva)", () => {
  const fuente = readFileSync(join(process.cwd(), "core/gmail/automatico/analyze.ts"));
  const huella = createHash("sha256").update(fuente).digest("hex").slice(0, 12);
  assert.equal(huella, HUELLA_ANALIZADOR_CORREO,
    `core/gmail/automatico/analyze.ts cambió (huella ${huella}). Sube VERSION_ANALISIS (ahora ${VERSION_ANALISIS}) en model.ts ` +
    `y pon HUELLA_ANALIZADOR_CORREO = "${huella}"; si no, los correos ya analizados conservarán la lectura antigua.`);
});

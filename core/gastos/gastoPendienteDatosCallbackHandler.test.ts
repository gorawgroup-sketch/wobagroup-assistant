import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Este handler usaba su propio "responderCallback" en vez del mecanismo compartido de preguntas
// caducadas (retirarPreguntaCaducada) — por eso el barrido de PR #197 (que solo buscaba llamadas a
// answerCallbackQuerySafe) no lo encontró. La pendiente ya consumida/reemplazada debe desaparecer del
// chat igual que en el resto de handlers, no solo quedarse sin botones.
test("una pendiente ya consumida se retira con el mecanismo compartido de preguntas caducadas", async () => {
  const fuente = await readFile(join(process.cwd(), "core/gastos/gastoPendienteDatosCallbackHandler.ts"), "utf8");
  assert.match(fuente, /import \{ retirarPreguntaCaducada \} from "\.\.\/telegram\/preguntaCaducada";/);
  assert.match(
    fuente,
    /if \(!pendiente\) \{\s*\/\/[^\n]*\n\s*await retirarPreguntaCaducada\(callback, "Esta pendiente ya fue procesada o reemplazada\."\);\s*return;\s*\}/
  );
});

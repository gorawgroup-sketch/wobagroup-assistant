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

// Una pendiente que espera al banco («moneda») ya no se rechaza como «no corresponde»: se puede buscar de nuevo, elegir uno
// de los cargos ofrecidos (reanuda con su importe y moneda REALES) o dejarla pendiente y seguir. Confirmar el análisis
// sigue siendo solo para duplicados.
test("las pendientes de moneda aceptan reintentar, elegir cargo y posponer; confirmar sigue siendo solo de duplicados", async () => {
  const fuente = await readFile(join(process.cwd(), "core/gastos/gastoPendienteDatosCallbackHandler.ts"), "utf8");
  assert.match(fuente, /const MOTIVOS_CON_BOTONES = new Set\(\["verificacion_duplicado", "moneda"\]\)/);
  assert.match(fuente, /accion === "gpd_confirmar" \? pendiente\.motivo === "verificacion_duplicado" : MOTIVOS_CON_BOTONES\.has\(pendiente\.motivo\)/);
  assert.match(fuente, /accion === "gpd_cargo" && pendiente\.motivo !== "moneda"/);
  assert.match(fuente, /montoEquivalente: cargoElegido\.monto, monedaEquivalente: cargoElegido\.moneda/);
  assert.match(fuente, /if \(!pendiente \|\| !MOTIVOS_CON_BOTONES\.has\(pendiente\.motivo\) \|\| !pendiente\.deColaCorreo/);
});

test("elegir un cargo es una acción sensible (solo superadministrador) y el despachador la enruta al mismo manejador", async () => {
  const sensibles = await readFile(join(process.cwd(), "core/telegram/authorizedUsersSheet.ts"), "utf8");
  assert.match(sensibles, /"gpd_cargo",/);
  const servidor = await readFile(join(process.cwd(), "src/server.ts"), "utf8");
  assert.match(servidor, /data\.startsWith\("gpd_"\)/);
});


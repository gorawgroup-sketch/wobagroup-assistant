import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * `npm test` (y por tanto el CI) corre en `sh`, donde `core/**` NO es recursivo: equivale a `core/*`. Hasta el
 * 03-10-2026 el guion era `core/**\/*.test.ts` y las pruebas de carpetas anidadas (core/gmail/automatico,
 * core/holded/automatizacion, core/holded/transferencias: 18 archivos, 265 pruebas) no se ejecutaban nunca en el CI
 * aunque en la terminal de cada uno (zsh) sí. Este guardarraíl falla si aparece una prueba a una profundidad que el
 * guion no nombra.
 */
function pruebasBajo(dir: string, profundidad: number, salida: Array<{ ruta: string; profundidad: number }> = []) {
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre);
    if (nombre === "node_modules") continue;
    if (statSync(ruta).isDirectory()) pruebasBajo(ruta, profundidad + 1, salida);
    else if (nombre.endsWith(".test.ts")) salida.push({ ruta, profundidad });
  }
  return salida;
}

test("el guion de pruebas nombra todas las profundidades en las que hay pruebas", () => {
  const guion = (JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts: { test: string } }).scripts.test;
  const pruebas = pruebasBajo(join(process.cwd(), "core"), 1);
  assert.ok(pruebas.length > 100, "no se encontraron las pruebas de core/");
  for (const profundidad of new Set(pruebas.map((p) => p.profundidad))) {
    const patron = `core/${"*/".repeat(profundidad - 1)}*.test.ts`;
    assert.ok(guion.includes(patron), `Hay pruebas a profundidad ${profundidad} (p. ej. ${pruebas.find((p) => p.profundidad === profundidad)?.ruta}) y el guion de npm test no incluye «${patron}».`);
  }
  assert.ok(!guion.includes("**"), "«**» no es recursivo en sh: nombra cada profundidad de forma explícita.");
});

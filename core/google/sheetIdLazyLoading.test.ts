import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

function archivosTypeScript(raiz: string): string[] {
  const encontrados: string[] = [];
  for (const nombre of readdirSync(raiz)) {
    const ruta = join(raiz, nombre);
    const estado = statSync(ruta);
    if (estado.isDirectory()) encontrados.push(...archivosTypeScript(ruta));
    else if (nombre.endsWith(".ts")) encontrados.push(ruta);
  }
  return encontrados;
}

test("ningún store vuelve a cachear CASHFLOW_SHEET_ID al cargar el módulo", () => {
  const raiz = join(process.cwd(), "core");
  const infractores = archivosTypeScript(raiz)
    .filter((ruta) => !ruta.endsWith(".test.ts"))
    .filter((ruta) => /^const\s+CASHFLOW_SHEET_ID\s*=\s*process\.env\.CASHFLOW_SHEET_ID/m.test(readFileSync(ruta, "utf8")))
    .map((ruta) => relative(process.cwd(), ruta));

  assert.deepEqual(infractores, []);
});

test("la clave de IA no es requisito de arranque porque puede estar desactivada por política de costes", () => {
  const servidor = readFileSync(join(process.cwd(), "src/server.ts"), "utf8");
  const bloqueRequisitos = servidor.match(/const REQUIRED_ENV_VARS = \[([^\]]*)\]/)?.[1] ?? "";
  assert.doesNotMatch(bloqueRequisitos, /ANTHROPIC_API_KEY/);
});

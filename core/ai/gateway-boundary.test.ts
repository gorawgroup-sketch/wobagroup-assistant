import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

function archivosTs(dir: string): string[] {
  const encontrados: string[] = [];
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) encontrados.push(...archivosTs(ruta));
    else if (ruta.endsWith(".ts")) encontrados.push(ruta);
  }
  return encontrados;
}

test("ningún módulo evita el gateway de IA", () => {
  const raiz = process.cwd();
  const gateway = join(raiz, "core", "ai", "anthropicGateway.ts");
  const esteTest = join(raiz, "core", "ai", "gateway-boundary.test.ts");
  const infractores = [...archivosTs(join(raiz, "core")), ...archivosTs(join(raiz, "src"))]
    .filter((ruta) => ruta !== gateway && ruta !== esteTest)
    .filter((ruta) => readFileSync(ruta, "utf8").includes("anthropic.messages.create"))
    .map((ruta) => relative(raiz, ruta));

  assert.deepEqual(infractores, []);
});

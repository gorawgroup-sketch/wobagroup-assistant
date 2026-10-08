import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { COBERTURA_NORMA } from "../ia/normaResolucionAutonoma";

/**
 * Guardarraíl de la norma de resolución autónoma (Carlos, 2026-10-08): todo módulo de `core/` que llama al modelo debe
 * inyectar la norma (completa o versión extractor) o estar exento con motivo escrito. Un agente nuevo que llame al modelo
 * sin declararse en COBERTURA_NORMA hace fallar esta prueba: la norma nace con cada agente, no se añade después.
 */
function modulosQueLlamanAlModelo(): string[] {
  const salida = execFileSync("grep", ["-rlE", "crearMensajeAnthropic|messages\\.create\\(", "core"], { cwd: process.cwd(), encoding: "utf8" });
  return salida.split("\n").map((l) => l.trim()).filter((l) => l && !l.endsWith(".test.ts") && !l.endsWith("normaResolucionAutonoma.ts")).sort();
}

test("todo módulo que llama al modelo está cubierto por la norma o exento con motivo", () => {
  const declarados = new Set(COBERTURA_NORMA.map((c) => c.archivo));
  const sinDeclarar = modulosQueLlamanAlModelo().filter((m) => !declarados.has(m));
  assert.deepEqual(sinDeclarar, [], `Módulos que llaman al modelo sin declarar en COBERTURA_NORMA: ${sinDeclarar.join(", ")}`);
  for (const c of COBERTURA_NORMA) {
    if (c.cumple === "exento") assert.ok(c.motivo?.trim(), `${c.archivo} está exento sin motivo`);
  }
});

test("los módulos que declaran cumplir la norma la importan de verdad", () => {
  for (const c of COBERTURA_NORMA) {
    if (c.cumple === "exento") continue;
    const fuente = readFileSync(join(process.cwd(), c.archivo), "utf8");
    assert.match(fuente, /from "\.\.\/(\.\.\/)*ia\/normaResolucionAutonoma"/, `${c.archivo} declara "${c.cumple}" pero no importa normaResolucionAutonoma`);
    const simbolo = c.cumple === "completa" ? /NORMA_RESOLUCION_AUTONOMA|bloqueNormaResolucion\(\)|bloqueNormaResolucion\("completa"\)/ : /NORMA_EXTRACTOR|bloqueNormaResolucion\("extractor"\)/;
    assert.match(fuente, simbolo, `${c.archivo} no usa la variante "${c.cumple}" de la norma`);
  }
});

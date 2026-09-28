import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { contarPorFichero, escanearTragarErrores, type Hallazgo } from "./tragarErrores";

const raiz = join(__dirname, "..", "..");
const lineaBase = JSON.parse(readFileSync(join(__dirname, "lineaBase.json"), "utf8")) as Record<string, number>;

test("el detector reconoce los patrones de «tragar el error con un valor por defecto» (y no los inocuos)", () => {
  const detectar = (fuente: string) => {
    const dir = join(require("node:os").tmpdir(), `guardarrail-${process.pid}-${Math.random().toString(36).slice(2)}`);
    require("node:fs").mkdirSync(join(dir, "core", "gastos"), { recursive: true });
    require("node:fs").writeFileSync(join(dir, "core", "gastos", "x.ts"), fuente);
    return escanearTragarErrores(dir).length;
  };
  assert.equal(detectar("const a = await leer().catch(() => []);"), 1);
  assert.equal(detectar("const a = await leer().catch((e) => { console.error(e); return new Set(['EUR']); });"), 1);
  assert.equal(detectar("try { await leer(); } catch (e) { console.error(e); return undefined; }"), 1);
  assert.equal(detectar("await enviar().catch(() => {});"), 0, "fire-and-forget con bloque vacío no es un valor por defecto");
  assert.equal(detectar("const a = await leer().catch((e) => { throw new Error('la consulta falló'); });"), 0);
});

test("ratchet: no aparecen NUEVOS «errores tragados con valor por defecto» en los módulos que deciden con lecturas de Holded", () => {
  const hallazgos = escanearTragarErrores(raiz);
  const actual = contarPorFichero(hallazgos);
  const nuevos: string[] = [];
  for (const [fichero, n] of Object.entries(actual)) {
    const permitido = lineaBase[fichero] ?? 0;
    if (n > permitido) {
      const lineas = hallazgos.filter((h: Hallazgo) => h.fichero === fichero).map((h) => `  ${h.fichero}:${h.linea} ${h.texto}`).join("\n");
      nuevos.push(`${fichero}: ${n} (línea base ${permitido})\n${lineas}`);
    }
  }
  assert.equal(
    nuevos.length,
    0,
    "Un fallo de lectura de Holded no demuestra nada (caso real 2026-09-28: «solo EUR»). Relanza el error, usa la última lectura buena o " +
      "avisa «la consulta falló». Si es de verdad inocuo (limpieza, caché, dato cosmético), sube la cifra en core/guardarrailes/lineaBase.json " +
      "tras revisarlo.\n" + nuevos.join("\n")
  );
});

test("la línea base solo puede bajar: si se arreglan sitios, hay que actualizarla para no dejar margen a otros nuevos", () => {
  const actual = contarPorFichero(escanearTragarErrores(raiz));
  const sobrante = Object.entries(lineaBase).filter(([fichero, n]) => (actual[fichero] ?? 0) < n).map(([fichero, n]) => `${fichero}: base ${n}, actual ${actual[fichero] ?? 0}`);
  assert.equal(sobrante.length, 0, `Baja la línea base (core/guardarrailes/lineaBase.json):\n${sobrante.join("\n")}`);
});

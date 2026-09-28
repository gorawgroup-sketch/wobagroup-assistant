import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Detecta «tragar un error y seguir con un valor por defecto» (`.catch(() => [])`, `catch { return undefined }`…) en los
 * módulos que TOMAN decisiones con lecturas de Holded. Caso real 2026-09-28: un 502/503 de Holded se convirtió en
 * «solo EUR» y se le dijo al operador que USD no era moneda de cuenta. Un fallo de lectura no demuestra nada.
 *
 * Es un ratchet: la línea base (`lineaBase.json`) recoge lo que ya existía. Un caso NUEVO hace fallar la prueba: hay que
 * justificarlo (relanzar, usar la última lectura buena o avisar «la consulta falló») o, si de verdad es inocuo (limpieza,
 * caché, dato cosmético), añadirlo a la línea base con una revisión consciente.
 */
export const MODULOS_DE_DECISION = [
  "core/gastos",
  "core/gmail/automatico",
  "core/holded/write.ts",
  "core/holded/client.ts",
  "core/jobs/revisarCorreoNuevo.ts",
];

const VALOR_POR_DEFECTO = String.raw`(?:\[\]|undefined|null|false|true|0|""|new Set\([^)]*\)|new Map\([^)]*\)|\{\})`;
// En una flecha, `=> {}` es un bloque vacío (fire-and-forget), no un valor: solo `=> ({})` lo es.
const VALOR_EN_FLECHA = String.raw`(?:\[\]|undefined|null|false|true|0|""|new Set\([^)]*\)|new Map\([^)]*\)|\(\{\}\))`;
const PATRONES: Array<{ nombre: string; regex: RegExp }> = [
  // .catch(() => [])  /  .catch((e) => undefined)
  { nombre: "catch_en_linea", regex: new RegExp(String.raw`\.catch\(\s*(?:\(\s*\w*\s*\)|\w+)?\s*=>\s*${VALOR_EN_FLECHA}\s*\)`, "g") },
  // .catch((error) => { console.error(...); return [] })
  { nombre: "catch_con_bloque", regex: new RegExp(String.raw`\.catch\(\s*(?:\(\s*\w*\s*\)|\w+)?\s*=>\s*\{[^{}]{0,400}?return\s+${VALOR_POR_DEFECTO}\s*;?\s*\}\s*\)`, "gs") },
  // try { ... } catch (e) { ...; return [] }
  { nombre: "try_catch_devuelve_por_defecto", regex: new RegExp(String.raw`catch\s*(?:\(\s*\w*\s*\))?\s*\{[^{}]{0,400}?return\s+${VALOR_POR_DEFECTO}\s*;?\s*\}`, "gs") },
];

function ficheros(raiz: string, ruta: string): string[] {
  const absoluta = join(raiz, ruta);
  if (!existsSync(absoluta)) return [];
  const info = statSync(absoluta);
  if (info.isFile()) return ruta.endsWith(".ts") && !ruta.endsWith(".test.ts") ? [ruta] : [];
  return readdirSync(absoluta).flatMap((nombre) => {
    return ficheros(raiz, join(ruta, nombre));
  });
}

export interface Hallazgo { fichero: string; linea: number; patron: string; texto: string }

export function escanearTragarErrores(raiz: string): Hallazgo[] {
  const hallazgos: Hallazgo[] = [];
  for (const modulo of MODULOS_DE_DECISION) {
    for (const fichero of ficheros(raiz, modulo)) {
      const fuente = readFileSync(join(raiz, fichero), "utf8");
      for (const { nombre, regex } of PATRONES) {
        for (const m of fuente.matchAll(regex)) {
          const linea = fuente.slice(0, m.index).split("\n").length;
          hallazgos.push({ fichero: relative(raiz, join(raiz, fichero)), linea, patron: nombre, texto: m[0].replace(/\s+/g, " ").slice(0, 160) });
        }
      }
    }
  }
  return hallazgos;
}

export function contarPorFichero(hallazgos: Hallazgo[]): Record<string, number> {
  const cuenta: Record<string, number> = {};
  for (const h of hallazgos) cuenta[h.fichero] = (cuenta[h.fichero] ?? 0) + 1;
  return Object.fromEntries(Object.entries(cuenta).sort(([a], [b]) => a.localeCompare(b)));
}

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { MAX_ADJUNTOS_PARA_EDITAR, permiteEditarConAdjuntos } from "../holded/write";

/**
 * NORMA DE ADJUNTOS (2026-10-13). En Holded cada PUT de una compra duplica sus adjuntos (2^n) y la API no permite borrarlos: caso real,
 * 6 compras de Footprint con entre 256 y 32.768 copias de su comprobante, una de ellas imposible de abrir. Estas pruebas fijan la norma en el
 * propio código, para que un cambio futuro no pueda abrir otro camino sin que salten.
 */
const raiz = join(__dirname, "..", "..");

function ficheros(dir: string, salida: string[] = []): string[] {
  for (const nombre of readdirSync(dir)) {
    if (nombre === "node_modules" || nombre.startsWith(".")) continue;
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) ficheros(ruta, salida);
    else if (ruta.endsWith(".ts") && !ruta.endsWith(".test.ts")) salida.push(ruta);
  }
  return salida;
}
const fuentes = [...ficheros(join(raiz, "core")), ...ficheros(join(raiz, "src"))].map((f) => ({ f: relative(raiz, f), codigo: readFileSync(f, "utf8") }));

test("regla de adjuntos: una automatización nunca edita una compra con adjuntos; una persona no si ya está duplicada", () => {
  for (const n of [0]) assert.equal(permiteEditarConAdjuntos(n, true), true, `automática con ${n}`);
  for (const n of [1, 2, 4, 32768]) assert.equal(permiteEditarConAdjuntos(n, true), false, `automática con ${n}`);
  for (const n of [0, 1, 2]) assert.equal(permiteEditarConAdjuntos(n, false), true, `persona con ${n}`);
  for (const n of [MAX_ADJUNTOS_PARA_EDITAR, 4, 256, 32768]) assert.equal(permiteEditarConAdjuntos(n, false), false, `persona con ${n}`);
  assert.equal(MAX_ADJUNTOS_PARA_EDITAR, 3, "con 3 se bloquea: el peor caso real son 4 copias, nunca miles");
});

test("ÚNICO punto de escritura PUT sobre compras de Holded: aplicarEdicionPreparada (con su guardia de adjuntos y su frontera durable)", () => {
  const llamadas = fuentes.flatMap(({ f, codigo }) => [...codigo.matchAll(/holdedWriteCall\(\s*[A-Za-z_.]+\s*,\s*"PUT"/g)].map(() => f));
  assert.deepEqual(llamadas, ["core/holded/write.ts"], `PUT sobre Holded fuera del punto único: ${llamadas.join(", ")}`);
  const fetchPut = fuentes.filter(({ codigo }) => /api\.holded\.com|HOLDED_API_BASE/.test(codigo) && /method:\s*"PUT"/.test(codigo)).map((x) => x.f);
  assert.deepEqual(fetchPut, [], `fetch PUT a Holded fuera del punto único: ${fetchPut.join(", ")}`);
});

test("subir adjuntos a una compra solo pasa por los dos caminos conocidos (el durable y el del flujo automático de correo)", () => {
  const permitidos = new Set(["core/holded/write.ts", "core/gmail/automatico/holded.ts"]);
  const infractores = fuentes.filter(({ f, codigo }) => {
    if (permitidos.has(f)) return false;
    return [...codigo.matchAll(/\/attachments[`"']/g)].some((m) => /method:\s*"POST"|\.post\(|\.append\("file"/.test(codigo.slice(m.index!, m.index! + 400)));
  }).map((x) => x.f);
  assert.deepEqual(infractores, [], `Nueva vía de subida de adjuntos a Holded sin pasar por la norma: ${infractores.join(", ")}`);
});

test("todo llamador de adjuntarComprobanteHolded y de editarCompraHolded entrega una clave idempotente (sin ella no hay frontera durable)", () => {
  const sinClave: string[] = [];
  for (const { f, codigo } of fuentes) {
    if (f === "core/holded/write.ts") continue;
    for (const nombre of ["adjuntarComprobanteHolded", "editarCompraHolded"]) {
      for (const m of codigo.matchAll(new RegExp(`\\b${nombre}\\(`, "g"))) {
        const previo = codigo.slice(Math.max(0, m.index! - 40), m.index!);
        if (/import|function|async\s*$/.test(previo) || /^\s*(export\s+)?(async\s+)?function/.test(previo)) continue;
        if (!/idempotencyKey/.test(codigo.slice(m.index!, m.index! + 900))) sinClave.push(`${f}: ${nombre}`);
      }
    }
  }
  assert.deepEqual(sinClave, [], `Llamadas sin idempotencyKey: ${sinClave.join("; ")}`);
});

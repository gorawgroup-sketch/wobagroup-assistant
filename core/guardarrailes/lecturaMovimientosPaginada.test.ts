import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

/**
 * Guardarraíl (caso real 2026-10-01, citizenM/Booking 124,91 €): las búsquedas de movimientos bancarios leían solo la
 * primera página de Holded y concluían «no hay cargo». Toda lectura de `/bank-movements` debe pasar por un lector que
 * recorra TODAS las páginas. Aquí se fija qué archivos pueden nombrar esa ruta; si aparece uno nuevo, este test obliga
 * a usar paginarMovimientosBancarios (o a justificar aquí por qué ya pagina por su cuenta).
 */
const PERMITIDOS: Record<string, string> = {
  "core/holded/client.ts": "listBankMovements usa paginarMovimientosBancarios",
  "core/holded/write.ts": "búsquedas con paginarMovimientosBancarios; duplicados y lectura por id paginan con cursor; reconcile es escritura",
  "core/holded/paginarMovimientos.ts": "el paginador",
  "core/gastos/busquedaSinFecha.ts": "pagina con cursor y falla si queda incompleta",
  "core/gmail/automatico/holded.ts": "HoldedAuto.listar pagina con cursor y falla si queda incompleta",
  "core/casosReales/banco.ts": "simulador de pruebas con casos reales",
  "core/gmail/automatico/postgres.ts": "solo reconoce la ruta de ESCRITURA …/reconcile para la guardia; no lee movimientos",
};

function archivosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) return nombre === "node_modules" ? [] : archivosTs(ruta);
    return /\.ts$/.test(nombre) && !/\.test\.ts$/.test(nombre) ? [ruta] : [];
  });
}

test("ratchet: ninguna lectura nueva de movimientos bancarios fuera de los lectores paginados", () => {
  const raiz = process.cwd();
  const conRuta = archivosTs(join(raiz, "core")).concat(archivosTs(join(raiz, "src")))
    .filter((ruta) => readFileSync(ruta, "utf8").includes("/bank-movements"))
    .map((ruta) => relative(raiz, ruta).split("\\").join("/"));
  const nuevos = conRuta.filter((ruta) => !(ruta in PERMITIDOS));
  assert.deepEqual(nuevos, [], `Lectura de /bank-movements fuera de los lectores paginados: ${nuevos.join(", ")}. ` +
    "Usa paginarMovimientosBancarios (core/holded/paginarMovimientos.ts): una sola página no demuestra que no exista un cargo.");
  // Y las dos búsquedas que fallaron no pueden volver a leer una sola página.
  const write = readFileSync(join(raiz, "core/holded/write.ts"), "utf8");
  assert.equal((write.match(/paginarMovimientosBancarios</g) ?? []).length >= 2, true);
  // Las demás lecturas de write.ts (duplicados y lectura por id) ya recorren el cursor: toda petición de movimientos
  // con parámetros propios debe ir acompañada de su manejo de cursor en el mismo bloque.
  const bloques = write.split("/bank-movements?${params.toString()}").slice(1);
  for (const bloque of bloques) assert.match(bloque.slice(0, 2500), /cursor/, "lectura de movimientos sin recorrer el cursor");
});

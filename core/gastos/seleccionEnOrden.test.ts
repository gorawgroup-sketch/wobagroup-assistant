import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { conSeleccionGasto } from "./gastoProposalSheet";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Hoja simulada: guardar una casilla tarda 40 ms (como una lectura de Sheets con 429) y leer es inmediato. */
function hojaLenta() {
  let guardada: string[] = [];
  return {
    async marcar(clave: string) { await dormir(40); guardada = [...guardada, clave]; },
    async leer() { return [...guardada]; },
  };
}

test("sin cola, la aprobación lee la selección vacía mientras la casilla aún se guarda (el fallo real de Rappi)", async () => {
  const hoja = hojaLenta();
  const casilla = hoja.marcar("crearconciliar");
  const aprobacion = hoja.leer();
  assert.deepEqual(await aprobacion, []);
  await casilla;
});

test("con la cola de la propuesta, la aprobación espera a la casilla anterior y lee la selección ya guardada", async () => {
  const hoja = hojaLenta();
  const casilla = conSeleccionGasto("p1", () => hoja.marcar("crearconciliar"));
  const aprobacion = conSeleccionGasto("p1", () => hoja.leer());
  assert.deepEqual(await aprobacion, ["crearconciliar"]);
  await casilla;
});

test("la cola es por propuesta: una casilla pendiente de una propuesta no retrasa a otra (sin depender de tiempos)", async () => {
  let liberar!: () => void;
  const retenida = new Promise<void>((resolver) => { liberar = resolver; });
  const lenta = conSeleccionGasto("p1", () => retenida);
  // p2 termina mientras p1 sigue ocupada: si compartieran cola, esto no resolvería hasta liberar p1.
  assert.equal(await conSeleccionGasto("p2", async () => "p2 terminó"), "p2 terminó");
  // Y una segunda operación de p1 sí espera a la primera.
  const ordenadas: string[] = [];
  const segunda = conSeleccionGasto("p1", async () => { ordenadas.push("segunda"); });
  await Promise.resolve();
  assert.deepEqual(ordenadas, []);
  liberar();
  await lenta;
  await segunda;
  assert.deepEqual(ordenadas, ["segunda"]);
});

test("guarda: marcar y aprobar usan la cola de la propuesta (si alguien la quita, vuelve el fallo «No marcaste ninguna acción»)", () => {
  const manejador = readFileSync(join(process.cwd(), "core/gastos/gastoCallbackHandler.ts"), "utf8");
  const hoja = readFileSync(join(process.cwd(), "core/gastos/gastoProposalSheet.ts"), "utf8");
  const bloque = (fuente: string, inicio: string) => {
    const i = fuente.indexOf(inicio);
    assert.ok(i >= 0, `no se encuentra ${inicio}`);
    return fuente.slice(i, i + 1800);
  };
  assert.match(bloque(manejador, "async function handleGastoToggleCallback"), /modificarSeleccionAccionesGasto\(/);
  assert.match(bloque(manejador, "async function handleGastoAprobarCallback"), /conSeleccionGasto\(propuestaId/);
  assert.match(bloque(hoja, "export async function actualizarSeleccionAccionesGasto"), /conSeleccionGasto\(/);
  assert.match(bloque(hoja, "export async function modificarSeleccionAccionesGasto"), /conSeleccionGasto\(/);
});

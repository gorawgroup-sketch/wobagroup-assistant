import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("la cola es por propuesta: una casilla lenta de una propuesta no retrasa a otra", async () => {
  const hoja = hojaLenta();
  const lenta = conSeleccionGasto("p1", () => hoja.marcar("crear"));
  const inicio = Date.now();
  await conSeleccionGasto("p2", async () => undefined);
  assert.ok(Date.now() - inicio < 30, "p2 no espera a p1");
  await lenta;
});

test("guarda: marcar y aprobar usan la cola de la propuesta (si alguien la quita, vuelve el fallo «No marcaste ninguna acción»)", () => {
  const manejador = readFileSync(new URL("./gastoCallbackHandler.ts", import.meta.url), "utf8");
  const hoja = readFileSync(new URL("./gastoProposalSheet.ts", import.meta.url), "utf8");
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

import assert from "node:assert/strict";
import test from "node:test";
import { analizarCadenaDeSaldos } from "./cadena";
import { BBVA_REAL } from "./fixtures/bbvaWoba2026_10_05";
import type { MovimientoBanco } from "./tipos";

function mov(id: string, fecha: string, importe: number, saldoTras: number | null, descripcion = id): MovimientoBanco {
  return { empresa: "WOBA", cuentaId: "bbva", cuenta: "BBVA", id, fecha, descripcion, importe, moneda: "EUR", importeEur: importe, estado: "pending", saldoTras };
}

test("los dos adeudos del 01/09 que el banco devolvió salen como huérfanos: ninguno entró en el saldo", () => {
  const { estado } = analizarCadenaDeSaldos(BBVA_REAL);
  assert.equal(estado.get("allianz_01_09"), "huerfano");
  assert.equal(estado.get("aegon_01_09"), "huerfano");
});

test("el reintento de Aegon del 09/09 y los cargos normales sí están en la cadena", () => {
  const { estado } = analizarCadenaDeSaldos(BBVA_REAL);
  for (const id of ["aegon_09_09", "aegon_01_10", "culligan_04_09", "iberdrola_08_09", "traspaso_02_09", "impuestos_01_10"]) {
    assert.equal(estado.get(id), "liquidado", id);
  }
});

test("los cargos del 05/10 (Markel, Culligan) están en una rama que el saldo todavía no confirma: en tránsito, no pagados", () => {
  const { estado } = analizarCadenaDeSaldos(BBVA_REAL);
  assert.equal(estado.get("markel_05_10"), "en_transito");
  assert.equal(estado.get("culligan_05_10"), "en_transito");
  // Las dos ramas del mismo día son igual de inciertas hasta que entre un apunte posterior.
  assert.equal(estado.get("cobro_05_10"), "en_transito");
  assert.equal(estado.get("sobregiro_05_10"), "en_transito");
});

test("la cadena de la cuenta BBVA es fiable (2 huérfanos entre 33 apuntes asentados)", () => {
  const { fiable, ultimaFecha } = analizarCadenaDeSaldos(BBVA_REAL);
  assert.equal(fiable, true);
  assert.equal(ultimaFecha, "2026-10-05");
});

test("cuando entra un apunte posterior sobre la rama buena, la otra rama pasa a huérfana: el cargo no se aplicó", () => {
  // Si mañana el saldo continúa desde 804.85 (la rama de los dos abonos), Markel y Culligan quedan fuera de la cadena.
  const manana = [...BBVA_REAL, mov("telefonica_06_10", "2026-10-06", -20, 784.85)];
  const { estado } = analizarCadenaDeSaldos(manana);
  assert.equal(estado.get("markel_05_10"), "huerfano");
  assert.equal(estado.get("culligan_05_10"), "huerfano");
  assert.equal(estado.get("cobro_05_10"), "liquidado");
  assert.equal(estado.get("sobregiro_05_10"), "liquidado");
});

test("y si continúa desde la rama de Markel, son los dos abonos los que quedan fuera (el cargo sí se aplicó)", () => {
  const manana = [...BBVA_REAL, mov("telefonica_06_10", "2026-10-06", -20, -419.28)];
  const { estado } = analizarCadenaDeSaldos(manana);
  assert.equal(estado.get("markel_05_10"), "liquidado");
  assert.equal(estado.get("cobro_05_10"), "huerfano");
});

test("una cuenta cuyos saldos no encadenan (Revolut con compras «pending») no es fiable: no se usa para decidir", () => {
  const ruido: MovimientoBanco[] = [];
  for (let i = 0; i < 40; i++) ruido.push(mov(`compra_${i}`, `2026-09-${String(1 + (i % 28)).padStart(2, "0")}`, -(i + 1), 1000 + ((i * 37) % 500)));
  const { fiable } = analizarCadenaDeSaldos(ruido);
  assert.equal(fiable, false);
});

test("sin saldos en los apuntes no hay nada que comprobar", () => {
  const { estado, fiable } = analizarCadenaDeSaldos([mov("a", "2026-10-01", -5, null), mov("b", "2026-10-02", -6, null)]);
  assert.equal(estado.get("a"), "sin_saldo");
  assert.equal(fiable, false);
});

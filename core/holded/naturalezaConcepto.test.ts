import assert from "node:assert/strict";
import test from "node:test";
import { comparteNaturaleza, palabrasNaturalezaGasto } from "./naturalezaConcepto";

// Caso real 2026-09-28: compra M0U135004 de D1 SAS (Footprint) archivada en «Commission».
const CONCEPTO_D1 = "Compra elementos de aseo y limpieza (toallas de manos, papel de cocina, limpiador, cera autobrillante, guantes, esponja, lavaloza, infusión, té matcha, platanitos maduros, monedita de plátano) — D1 S.A.S., Colombia — Footprint Latin America (72800.01 COP, comprobante en COP)";
const LINEA_COMISIONES = "Sales Commissions for all Client’s in Central America AUG /25 period";

test("el nombre de la empresa, el país y el proveedor no son naturaleza del gasto", () => {
  const palabras = palabrasNaturalezaGasto(CONCEPTO_D1, { proveedor: "D1 S.A.S." });
  for (const ruido of ["america", "latin", "footprint", "colombia", "comprobante", "compra"]) {
    assert.equal(palabras.includes(ruido), false, `«${ruido}» no debe contar`);
  }
  for (const real of ["limpieza", "toallas", "limpiador", "esponja"]) assert.ok(palabras.includes(real), real);
});

test("el ticket de supermercado ya no es comparable con una línea de comisiones de venta", () => {
  const palabras = palabrasNaturalezaGasto(CONCEPTO_D1, { proveedor: "D1 S.A.S." });
  assert.equal(comparteNaturaleza(LINEA_COMISIONES, palabras), false);
});

test("una compra de la misma naturaleza sí es comparable (dos palabras compartidas)", () => {
  const palabras = palabrasNaturalezaGasto(CONCEPTO_D1, { proveedor: "D1 S.A.S." });
  assert.equal(comparteNaturaleza("Productos de limpieza: limpiador multiusos y guantes", palabras), true);
  assert.equal(comparteNaturaleza("Servicio de limpieza de oficina", palabras), false); // una sola palabra: no basta
});

test("un concepto de una sola palabra de naturaleza sigue pudiendo coincidir por esa palabra", () => {
  const palabras = palabrasNaturalezaGasto("Hosting — Proveedor X, Irlanda — WOBA Business Group", { proveedor: "Proveedor X" });
  assert.deepEqual(palabras, ["hosting"]);
  assert.equal(comparteNaturaleza("Hosting anual del dominio", palabras), true);
});

test("las palabras de la persona no deciden la cuenta y un concepto sin naturaleza no coincide con nada", () => {
  const palabras = palabrasNaturalezaGasto("Almuerzo Salazar Camilo", { personaAsociada: "Juan Camilo Salazar" });
  assert.deepEqual(palabras, ["almuerzo"]);
  assert.equal(comparteNaturaleza("cualquier cosa", palabrasNaturalezaGasto("Compra — X — Footprint Latin America")), false);
});

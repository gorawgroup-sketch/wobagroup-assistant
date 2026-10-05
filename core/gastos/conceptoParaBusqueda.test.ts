import assert from "node:assert/strict";
import test from "node:test";

process.env.HOLDED_API_KEY_WRITE_FOOTPRINT = "clave-de-prueba";
process.env.HOLDED_API_KEY_FOOTPRINT = "clave-de-prueba";

import { movimientoCompatibleConGasto } from "../holded/write";
import type { CompraHoldedCruda } from "../holded/write";
import { conceptoParaBusqueda } from "./conceptoParaBusqueda";

const PROVEEDOR = "PARADISE VALLEY SAS (MOME Moments & Stays)";
const SOLO_NOMBRE = `${PROVEEDOR} — 446403 COP`;
const compraMome = {
  id: "6ac380bf", description: "Hospedaje Hotel MOME (Paradise Valley SAS) — Medellín, Colombia (2 noches, alojamiento exento)",
  lines: [{ name: "Hospedaje Hotel MOME (Paradise Valley SAS) — Medellín, Colombia (2 noches, alojamiento exento)" }],
  tags: ["hospedaje", "simontalloen"],
} as unknown as CompraHoldedCruda;

test("caso MOME: sin concepto el cargo «The Cut Hotel» es incompatible; con el concepto de la compra, compatible", async () => {
  assert.equal(movimientoCompatibleConGasto(PROVEEDOR, SOLO_NOMBRE, "The Cut Hotel", { nucleoDeMarca: true }), false);
  const concepto = await conceptoParaBusqueda("Footprint", "6ac380bf", SOLO_NOMBRE, PROVEEDOR, async () => compraMome);
  assert.match(concepto, /Hospedaje Hotel MOME/);
  assert.equal(movimientoCompatibleConGasto(PROVEEDOR, concepto, "The Cut Hotel", { nucleoDeMarca: true }), true);
});

test("si la descripción recibida ya tiene categoría no se lee la compra", async () => {
  let lecturas = 0;
  const r = await conceptoParaBusqueda("Footprint", "x", "Hospedaje Hotel MOME", PROVEEDOR, async () => { lecturas++; return compraMome; });
  assert.equal(r, "Hospedaje Hotel MOME");
  assert.equal(lecturas, 0);
});

test("un fallo de lectura no impide buscar: se usa la descripción recibida", async () => {
  const r = await conceptoParaBusqueda("Footprint", "x", SOLO_NOMBRE, PROVEEDOR, async () => { throw new Error("Holded 503"); });
  assert.equal(r, SOLO_NOMBRE);
});

test("una compra sin descripción, líneas ni etiquetas deja la descripción intacta; el texto añadido se acota", async () => {
  assert.equal(await conceptoParaBusqueda("Footprint", "x", SOLO_NOMBRE, PROVEEDOR, async () => ({ id: "x" }) as CompraHoldedCruda), SOLO_NOMBRE);
  const larga = await conceptoParaBusqueda("Footprint", "x", SOLO_NOMBRE, PROVEEDOR,
    async () => ({ id: "x", description: "Hospedaje ".repeat(200) }) as unknown as CompraHoldedCruda);
  assert.ok(larga.length <= SOLO_NOMBRE.length + 3 + 500);
});

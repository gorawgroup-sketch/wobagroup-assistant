import assert from "node:assert/strict";
import test from "node:test";
import { MonedasCuentasReales, monedasDeCuentasActivas } from "./monedasCuentas";

const footprint = [
  { currency: "EUR" }, { currency: "usd " }, { currency: "COP" },
  { currency: "GBP", archived: true }, { archived: false }, { currency: "" },
];

test("solo cuentan las cuentas activas con moneda, normalizadas", () => {
  assert.deepEqual([...monedasDeCuentasActivas(footprint)].sort(), ["COP", "EUR", "USD"]);
});

test("lectura correcta: devuelve las monedas reales (Footprint tiene EUR, USD y COP)", async () => {
  const c = new MonedasCuentasReales(async () => footprint);
  assert.deepEqual([...await c.obtener("Footprint")].sort(), ["COP", "EUR", "USD"]);
});

test("caso real 2026-09-28: con Holded en 502/503 se usa la última lectura buena, nunca «solo EUR»", async () => {
  let caido = false;
  const avisos: string[] = [];
  const c = new MonedasCuentasReales(
    async () => { if (caido) throw new Error("Error de la API de Holded (503)"); return footprint; },
    () => 1_000_000,
    (m) => avisos.push(m)
  );
  await c.obtener("Footprint");
  caido = true;
  const monedas = await c.obtener("Footprint");
  assert.equal(monedas.has("USD"), true, "USD sigue siendo moneda de cuenta real");
  assert.deepEqual([...monedas].sort(), ["COP", "EUR", "USD"]);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /última lectura buena/);
});

test("sin ninguna lectura buena previa el error se relanza: nunca se inventa un valor", async () => {
  const c = new MonedasCuentasReales(async () => { throw new Error("Error de la API de Holded (503)"); });
  await assert.rejects(c.obtener("Footprint"), /503/);
});

test("una lista vacía tampoco demuestra nada: sin lectura previa lanza y con lectura previa la conserva", async () => {
  let vacia = true;
  const c = new MonedasCuentasReales(async () => (vacia ? [] : footprint), () => 5, () => {});
  await assert.rejects(c.obtener("Footprint"), /ninguna cuenta/);
  vacia = false;
  await c.obtener("Footprint");
  vacia = true;
  assert.deepEqual([...await c.obtener("Footprint")].sort(), ["COP", "EUR", "USD"]);
});

test("cada empresa conserva su propia lectura y el resultado es una copia", async () => {
  const cuentas: Record<string, Array<{ currency: string }>> = { Footprint: footprint as any, WOBA: [{ currency: "EUR" }] };
  let caido = false;
  const c = new MonedasCuentasReales(async (e) => { if (caido) throw new Error("caído"); return cuentas[e]; }, () => 1, () => {});
  const a = await c.obtener("Footprint");
  await c.obtener("WOBA");
  a.add("XXX");
  caido = true;
  assert.deepEqual([...await c.obtener("WOBA")], ["EUR"]);
  assert.equal((await c.obtener("Footprint")).has("XXX"), false, "modificar el resultado no contamina la memoria");
});

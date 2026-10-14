import assert from "node:assert/strict";
import test from "node:test";
import { planificarLote, valorDeCelda } from "./loteImpuestosPlan";
import type { SeccionImpuestosLeida } from "./cashflowImpuestos";

/**
 * Lote de impuestos del cashflow (Carlos, 2026-10-14, liquidaciones del 3T de la gestoría): del pedido al lote con botón, comparando con lo que ya hay.
 */
const fila = (n: number, impuesto: string, semana: string, valor: string, anio = "2026") => ({ fila: n, impuesto, semana, valor, anio });
const porPagar: SeccionImpuestosLeida = { filaTitulo: 25, filaCabecera: 27, filas: [
  fila(28, "MOD 115 WOBA Q3", "S43", "€1,867.22"), fila(29, "MOD 111 WOBA Q3", "S43", "€7,903.62"), fila(30, "MOD 111 EWORKS Q3", "S43", "€1,308.38"),
  fila(31, "MOD 303 EWORKS Q2", "S43", "€2,965.64"), fila(33, "", "", ""),
], filaLimite: 45 };
const aplaz: SeccionImpuestosLeida = { filaTitulo: 45, filaCabecera: 47, filas: [
  fila(48, "MOD 303 Q3 WOBA 2025", "S43", "€374.60"), fila(49, "MOD 303 Q3 WOBA 2025", "S47", "€375.87", "2026"),
] };
const secciones = { impuestos_por_pagar: porPagar, aplazamiento_impuestos: aplaz };

test("valorDeCelda entiende el formato de la hoja y el español", () => {
  assert.equal(valorDeCelda("€1,867.22"), 1867.22); assert.equal(valorDeCelda("1.867,22 €"), 1867.22); assert.equal(valorDeCelda("1867.22"), 1867.22); assert.equal(valorDeCelda(""), undefined);
});

test("el caso real: dos correcciones, dos altas y lo que ya está bien se avisa sin tocarlo", () => {
  const p = planificarLote(secciones, [
    { accion: "correccion", impuesto: "MOD 115 WOBA Q3", valor: 1926.99 }, { accion: "correccion", impuesto: "MOD 111 WOBA Q3", valor: 7947.82 },
    { accion: "correccion", impuesto: "MOD 111 EWORKS Q3", valor: 1308.38 },
    { accion: "alta", impuesto: "MOD 303 EWORKS Q3", semana: "S43", valor: 2392.57 }, { accion: "alta", impuesto: "MOD 202 EWORKS 2P IS", semana: "S43", valor: 2620.61 },
  ], "2026");
  assert.deepEqual(p.errores, []);
  assert.equal(p.operaciones.length, 4);
  assert.deepEqual(p.operaciones[0], { tipo: "correccion", descripcion: "MOD 115 WOBA Q3 (S43): 1.867,22 € → 1.926,99 €", datos: { fila: 28, esperado: { impuesto: "MOD 115 WOBA Q3", semana: "S43", valor: 1867.22 }, nuevo: { valor: 1926.99 } } });
  assert.deepEqual(p.operaciones[2].datos, { seccion: "impuestos_por_pagar", impuesto: "MOD 303 EWORKS Q3", semana: "S43", valor: 2392.57, anio: "2026" });
  assert.match(p.avisos[0], /MOD 111 EWORKS Q3 \(S43\) ya está en 1\.308,38 €: sin cambios/);
});

test("rechaza con motivo claro: duplicado, fila inexistente, ambigua, semana mal escrita, valor no positivo, operación sin cambios", () => {
  const e = (peticion: Parameters<typeof planificarLote>[1]) => planificarLote(secciones, peticion, "2026").errores.join(" | ");
  assert.match(e([{ accion: "alta", impuesto: "MOD 115 WOBA Q3", semana: "S43", valor: 5 }]), /ya existe en la fila 28/);
  assert.match(e([{ accion: "correccion", impuesto: "MOD 115 EWORKS Q3", valor: 5 }]), /no encuentro esa fila/);
  assert.match(e([{ accion: "correccion", impuesto: "MOD 303 Q3 WOBA 2025", valor: 5 }]), /hay 2 filas con ese nombre \(S43, S47\)/);
  assert.match(e([{ accion: "alta", impuesto: "X", semana: "43", valor: 5 }]), /formato «S43»/);
  assert.match(e([{ accion: "alta", impuesto: "X", semana: "S43", valor: -5 }]), /mayor que cero/);
  assert.match(e([{ accion: "alta", impuesto: "X" }]), /necesita semana y valor/);
  assert.match(e([{ accion: "correccion", impuesto: "MOD 115 WOBA Q3" }]), /necesita un valor, una semana o un año/);
});

test("una cuota concreta de un aplazamiento se corrige indicando su semana actual; no se corrige dos veces la misma fila ni se repite un alta", () => {
  const p = planificarLote(secciones, [{ accion: "correccion", impuesto: "MOD 303 Q3 WOBA 2025", semana_actual: "S47", valor: 380 }], "2026");
  assert.deepEqual(p.errores, []); assert.equal((p.operaciones[0].datos as { fila: number }).fila, 49);
  const q = planificarLote(secciones, [{ accion: "correccion", impuesto: "MOD 115 WOBA Q3", valor: 1 }, { accion: "correccion", impuesto: "MOD 115 WOBA Q3", semana: "S44" }], "2026");
  assert.match(q.errores.join(" "), /ya se corrige en otra operación/);
  const r = planificarLote(secciones, [{ accion: "alta", impuesto: "MOD 303 EWORKS Q3", semana: "S43", valor: 1 }, { accion: "alta", impuesto: "mod 303 eworks q3", semana: "S43", valor: 1 }], "2026");
  assert.match(r.errores.join(" "), /repetida en el mismo pedido/);
});

test("una corrección puede cambiar la semana y/o el año además del valor", () => {
  const p = planificarLote(secciones, [{ accion: "correccion", impuesto: "MOD 303 EWORKS Q2", semana: "S46", anio: "2026" }], "2026");
  assert.equal(p.operaciones[0].descripcion, "MOD 303 EWORKS Q2 (S43): semana S43 → S46");
  assert.deepEqual((p.operaciones[0].datos as { nuevo: unknown }).nuevo, { semana: "S46", anio: "2026" });
});

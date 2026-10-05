import assert from "node:assert/strict";
import test from "node:test";

process.env.HOLDED_API_KEY_WRITE_FOOTPRINT = "clave-de-prueba";
process.env.HOLDED_API_KEY_FOOTPRINT = "clave-de-prueba";

import { buscarMovimientoSimilar } from "../holded/write";
import type { ConciliacionVerificadaAprendida } from "../holded/conciliacionAprendidaSheet";
import { buscarMovimientosPorTipoCambio, type DependenciasBusquedaMultimoneda } from "./movimientoMultimoneda";

type Mov = Record<string, unknown>;
const mov = (o: Mov = {}): Mov => ({
  id: "m1", description: "Gustavocado", amount: "-9.31", currency: "EUR", accounting_amount: "-9.31",
  booking_date: "2026-10-03", status: "pending", reconciled_amount: "0.00", ...o,
});

/** Holded simulado: nada sale a la red y cualquier escritura falla la prueba. */
async function conHolded<T>(movimientos: Mov[], prueba: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? "GET") !== "GET") throw new Error("ESCRITURA BLOQUEADA EN PRUEBA");
    const cuerpo = String(url).includes("bank-movements") ? { items: movimientos, has_more: false } : { items: [{ id: "cuenta-eur", currency: "EUR" }] };
    return new Response(JSON.stringify(cuerpo), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try { return await prueba(); } finally { globalThis.fetch = original; }
}

const aprendida = (descripcion: string, proveedor: string): ConciliacionVerificadaAprendida => ({
  rowIndex: 2, clave: "k", empresa: "Footprint", proveedor, moneda: "EUR", accountId: "cuenta-eur", descripcionMovimiento: descripcion,
  ultimoMonto: 9.31, vecesConfirmado: 2, primeraConfirmacionEn: "", ultimaConfirmacionEn: "", gastoIdUltimo: "g", origenCoincidencia: "tipo_cambio",
});

function dependencias(aprendidas: ConciliacionVerificadaAprendida[] = []): DependenciasBusquedaMultimoneda {
  return {
    obtenerTasa: async () => 0.0002677641,
    buscarCercanos: (empresa, criterios, tolerancia) =>
      buscarMovimientoSimilar(empresa, criterios, tolerancia, { aprendidas: async () => aprendidas }),
    buscarPorNombre: async () => [],
  };
}

// Caso real 2026-10-05 (Footprint): recibo «Smash Avocadería» 33.800 COP del 03/10; el banco lo cargó como «Gustavocado» −9,31 €.
const criterios = { monto: 33800, moneda: "COP", fecha: "2026-10-03", proveedor: "Smash Avocadería", concepto: "Desayuno — tostada y açaí" };

test("sin incluirPorConfirmar (rutas que resuelven solas) un cargo de nombre distinto sigue sin ofrecerse", () =>
  conHolded([mov()], async () => {
    assert.deepEqual(await buscarMovimientosPorTipoCambio("Footprint", criterios, ["COP", "EUR"], dependencias()), []);
  }));

test("caso Gustavocado: con incluirPorConfirmar el cargo del día dentro de la tasa se ofrece «por confirmar»", () =>
  conHolded([mov()], async () => {
    const r = await buscarMovimientosPorTipoCambio("Footprint", { ...criterios, incluirPorConfirmar: true }, ["COP", "EUR"], dependencias());
    assert.equal(r.length, 1);
    assert.equal(r[0].descripcion, "Gustavocado");
    assert.equal(r[0].compatibilidad, "por_confirmar");
    assert.equal(r[0].origenCoincidencia, "tipo_cambio");
    assert.equal(r[0].coincideProveedor, false);
  }));

test("si ya se confirmó antes ese descriptor para el proveedor, se ofrece como «aprendido»", () =>
  conHolded([mov()], async () => {
    const r = await buscarMovimientosPorTipoCambio("Footprint", { ...criterios, incluirPorConfirmar: true }, ["COP", "EUR"],
      dependencias([aprendida("Gustavocado", "Smash Avocadería")]));
    assert.equal(r.length, 1);
    assert.equal(r[0].compatibilidad, "aprendido");
  }));

test("por confirmar sigue exigiendo débito, ±1 día, importe dentro del 3 % y categoría no contradictoria", async () => {
  const casos: Array<[string, Mov, Partial<typeof criterios>]> = [
    ["un ingreso del mismo importe", mov({ amount: "9.31", accounting_amount: "9.31" }), {}],
    ["fecha a 3 días", mov({ booking_date: "2026-10-06" }), {}],
    ["importe fuera de la tolerancia de cambio", mov({ amount: "-10.50", accounting_amount: "-10.50" }), {}],
    ["cargo de categoría conocida distinta (taxi) frente a un desayuno", mov({ description: "Uber Trip Bogota" }), {}],
    ["ya conciliado", mov({ status: "reconciled", reconciled_amount: "-9.31" }), {}],
  ];
  // En serie: cada caso sustituye globalThis.fetch y no pueden solaparse.
  for (const [nombre, movimiento, cambios] of casos) {
    await conHolded([movimiento], async () => {
      const r = await buscarMovimientosPorTipoCambio("Footprint", { ...criterios, ...cambios, incluirPorConfirmar: true }, ["COP", "EUR"], dependencias());
      assert.deepEqual(r, [], nombre);
    });
  }
});

test("un cargo que respalda el nombre gana a uno solo «por confirmar» (no fuerza elegir)", () =>
  conHolded([mov({ id: "a" }), mov({ id: "b", description: "SMASH AVOCADERIA BOGOTA", amount: "-9.10", accounting_amount: "-9.10" })], async () => {
    const r = await buscarMovimientosPorTipoCambio("Footprint", { ...criterios, incluirPorConfirmar: true }, ["COP", "EUR"], dependencias());
    assert.deepEqual(r.map((c) => c.movementId), ["b"]);
    assert.equal(r[0].compatibilidad, undefined);
  }));

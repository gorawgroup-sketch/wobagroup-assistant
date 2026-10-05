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

// ---- Reparto óptimo entre recibos pendientes (caso hotel MOME, 2026-10-05) ----
const competidor = (o: Partial<import("./movimientoMultimoneda").ReciboCompetidor> = {}): import("./movimientoMultimoneda").ReciboCompetidor => ({
  id: "otra", monto: 34700, moneda: "COP", fecha: "2026-10-03", proveedor: "Gustavocado SAS", concepto: "Desayuno", ...o,
});
const conCompetidores = (lista: Array<import("./movimientoMultimoneda").ReciboCompetidor> | Error): DependenciasBusquedaMultimoneda => ({
  ...dependencias(),
  obtenerCompetidores: async () => { if (lista instanceof Error) throw lista; return lista; },
});
const buscar = (deps: DependenciasBusquedaMultimoneda, extra: Record<string, unknown> = { repartoConPendientes: {} }) =>
  buscarMovimientosPorTipoCambio("Footprint", { ...criterios, incluirPorConfirmar: true, ...extra }, ["COP", "EUR"], deps);

test("reparto: un cargo que encaja claramente mejor con otro recibo pendiente no se ofrece a este", () =>
  conHolded([mov({ description: "Gustavocado" })], async () => {
    // Este recibo: 33.800 COP → 9,05 € (2,9 % frente a 9,31 €). El otro: 34.700 COP → 9,29 € (0,2 %).
    assert.deepEqual(await buscar(conCompetidores([competidor()])), []);
  }));

test("reparto: sin el indicador (rutas que resuelven solas o que no arman propuesta) no cambia nada", () =>
  conHolded([mov()], async () => {
    const r = await buscar(conCompetidores([competidor()]), {});
    assert.equal(r.length, 1);
  }));

test("reparto: un competidor que no encaja con el cargo (importe lejano o fecha lejana) no lo desplaza", async () => {
  const casos: Array<[string, ReturnType<typeof competidor>]> = [
    ["importe lejano", competidor({ monto: 60000 })],
    ["fecha lejana", competidor({ fecha: "2026-09-20" })],
    ["cargo sin nombre reconocido y fecha a 2 días (exige ±1)", competidor({ fecha: "2026-10-05" })],
  ];
  for (const [nombre, c] of casos) {
    await conHolded([mov()], async () => {
      assert.equal((await buscar(conCompetidores([c]))).length, 1, nombre);
    });
  }
});

test("reparto: este recibo encaja mejor que el competidor → conserva el cargo", () =>
  conHolded([mov({ description: "Gustavocado", amount: "-9.10", accounting_amount: "-9.10" })], async () => {
    // Referencia de este recibo 9,05 € (0,6 %); el competidor (34.700 COP → 9,29 €) queda al 2,0 %.
    assert.equal((await buscar(conCompetidores([competidor()]))).length, 1);
  }));

test("reparto: un fallo al leer los recibos pendientes no impide ofrecer el cargo", () =>
  conHolded([mov()], async () => {
    assert.equal((await buscar(conCompetidores(new Error("Sheets caído")))).length, 1);
  }));

test("reparto: no se cuenta a sí misma (propuesta excluida) y dos cargos se reparten sin dejar a ninguno sin pareja", () =>
  conHolded([mov({ id: "a", description: "Gustavocado" }), mov({ id: "b", description: "Gustavocado", amount: "-9.60", accounting_amount: "-9.60" })], async () => {
    // Referencias: este recibo 9,05 €, el otro 9,29 €. Cargos: a −9,31 € (rec.0 2,9 %, rec.1 0,2 %), b −9,60 € (rec.0 6 %, fuera; rec.1 3,3 %, fuera).
    // Solo «a» es admisible para este recibo y el otro lo ajusta mejor → se retira; la propia propuesta excluida no compite.
    assert.deepEqual(await buscar(conCompetidores([competidor()])), []);
    const propia = await buscar(conCompetidores([competidor({ id: "yo" })]), { repartoConPendientes: { excluirPropuestaId: "yo" } });
    assert.equal(propia.length, 1);
  }));

test("reparto: si falla la tasa de un competidor se ofrece la lista completa (no se pierde el cargo por un fallo de lectura)", () =>
  conHolded([mov()], async () => {
    const base = dependencias();
    let llamadas = 0;
    const deps: DependenciasBusquedaMultimoneda = {
      ...base,
      // La primera consulta (la de la búsqueda) funciona; las siguientes (competidores en otra fecha) fallan.
      obtenerTasa: async (...args) => { if (llamadas++ === 0) return base.obtenerTasa(...args); throw new Error("BCE caído"); },
      obtenerCompetidores: async () => [competidor({ moneda: "USD", fecha: "2026-10-02" })],
    };
    assert.equal((await buscar(deps)).length, 1);
  }));

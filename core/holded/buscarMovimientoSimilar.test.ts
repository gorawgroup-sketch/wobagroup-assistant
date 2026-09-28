import assert from "node:assert/strict";
import test from "node:test";

process.env.HOLDED_API_KEY_WRITE_FOOTPRINT = "clave-de-prueba";
process.env.HOLDED_API_KEY_FOOTPRINT = "clave-de-prueba";

import { buscarMovimientoSimilar, candidatoUtilizableParaGasto } from "./write";
import { construirTecladoGasto, opcionesTecladoDesdePropuesta } from "../gastos/gastoTeclado";
import type { ConciliacionVerificadaAprendida } from "./conciliacionAprendidaSheet";
import type { PropuestaGasto } from "../gastos/gastoProposalSheet";

type Mov = Record<string, unknown>;
const mov = (o: Mov = {}): Mov => ({
  id: "m1", description: "Par*just B Cuz Luxury", amount: "-3.91", currency: "USD", accounting_amount: "-3.35",
  booking_date: "2026-09-25", status: "pending", reconciled_amount: "0.00", ...o,
});

/** Holded simulado: nada sale a la red y cualquier escritura falla la prueba. */
async function conHolded<T>(movimientos: Mov[], prueba: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? "GET") !== "GET") throw new Error("ESCRITURA BLOQUEADA EN PRUEBA");
    const cuerpo = String(url).includes("bank-movements") ? { items: movimientos, has_more: false } : { items: [{ id: "cuenta-usd", currency: "USD" }] };
    return new Response(JSON.stringify(cuerpo), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try { return await prueba(); } finally { globalThis.fetch = original; }
}

const aprendida = (descripcion: string, proveedor: string): ConciliacionVerificadaAprendida => ({
  rowIndex: 2, clave: "k", empresa: "Footprint", proveedor, moneda: "USD", accountId: "cuenta-usd", descripcionMovimiento: descripcion,
  ultimoMonto: 3.91, vecesConfirmado: 3, primeraConfirmacionEn: "", ultimaConfirmacionEn: "", gastoIdUltimo: "g", origenCoincidencia: "exacta",
});
const sinAprendidas = { aprendidas: async () => [] as ConciliacionVerificadaAprendida[] };
const criterios = { monto: 3.91, fecha: "2026-09-25", moneda: "USD", proveedor: "Mi Cafetería", concepto: "Café" };

test("caso real 2026-09-28: «JUST B CUZ PLM» encuentra su cargo «Par*just B Cuz Luxury» sin marca (compatible por nombre)", () =>
  conHolded([mov()], async () => {
    const r = await buscarMovimientoSimilar("Footprint", { monto: 3.91, fecha: "2026-09-25", moneda: "USD", proveedor: "JUST B CUZ PLM", concepto: "Café — JUST B CUZ PLM, San Juan, Puerto Rico" }, undefined, sinAprendidas);
    assert.equal(r.length, 1);
    assert.equal(r[0].descripcion, "Par*just B Cuz Luxury");
    assert.equal(r[0].compatibilidad, undefined);
  }));

test("un cargo por_confirmar solo aparece en la búsqueda que arma propuestas; la que puede conciliar sin preguntar no lo ve", () =>
  conHolded([mov({ description: "SQ *XYZ 88" })], async () => {
    assert.deepEqual(await buscarMovimientoSimilar("Footprint", criterios, undefined, sinAprendidas), [], "intentarConciliar no debe autoseleccionarlo");
    const r = await buscarMovimientoSimilar("Footprint", { ...criterios, incluirPorConfirmar: true }, undefined, sinAprendidas);
    assert.equal(r.length, 1);
    assert.equal(r[0].compatibilidad, "por_confirmar");
  }));

test("por_confirmar exige débito, fecha ±1 día, categoría del cargo desconocida y nunca categorías contradictorias", () => {
  const casos: Array<[string, Mov, Partial<typeof criterios>]> = [
    ["un crédito o devolución del mismo importe", mov({ description: "SQ *XYZ 88", amount: "3.91" }), {}],
    ["fecha a 2 días", mov({ description: "SQ *XYZ 88", booking_date: "2026-09-27" }), {}],
    ["cargo de categoría conocida (restaurante) con un gasto sin categoría", mov({ description: "Osteria Del Lovo" }), { concepto: "Compra", proveedor: "Tienda Sol" }],
    ["taxi frente a restaurante", mov({ description: "Osteria Del Lovo" }), { concepto: "Taxi aeropuerto", proveedor: "Bolt" }],
    ["sin descripción", mov({ description: "" }), {}],
    ["ya conciliado", mov({ description: "SQ *XYZ 88", status: "reconciled", reconciled_amount: "-3.91" }), {}],
  ];
  // En serie: cada caso sustituye globalThis.fetch y no pueden solaparse.
  return (async () => {
    for (const [nombre, movimiento, cambios] of casos) {
      await conHolded([movimiento], async () => {
        const r = await buscarMovimientoSimilar("Footprint", { ...criterios, ...cambios, incluirPorConfirmar: true }, undefined, sinAprendidas);
        assert.deepEqual(r, [], nombre);
      });
    }
  })();
});

test("un cargo compatible por nombre gana a un por_confirmar del mismo importe (no fuerza elegir)", () =>
  conHolded([mov({ id: "a", description: "SQ *XYZ 88" }), mov({ id: "b", description: "Mi Cafetería Centro" })], async () => {
    const r = await buscarMovimientoSimilar("Footprint", { ...criterios, incluirPorConfirmar: true }, undefined, sinAprendidas);
    assert.deepEqual(r.map((c) => c.movementId), ["b"]);
    assert.equal(r[0].compatibilidad, undefined);
  }));

test("aprendizaje: un descriptor confirmado antes se ofrece como «aprendido» (sin aviso) aunque el cargo llegue 2 días después, y el teclado da botones de crear", () =>
  conHolded([mov({ description: "SQ *XYZ 88 SAN JUAN", booking_date: "2026-09-27" })], async () => {
    const deps = { aprendidas: async () => [aprendida("SQ *XYZ 88 SAN JUAN", "Mi Cafetería")] };
    assert.deepEqual(await buscarMovimientoSimilar("Footprint", criterios, undefined, deps), [], "en las búsquedas automáticas no se usa");
    const r = await buscarMovimientoSimilar("Footprint", { ...criterios, incluirPorConfirmar: true }, undefined, deps);
    assert.equal(r.length, 1);
    assert.equal(r[0].compatibilidad, "aprendido");
    const propuesta = { id: "p", empresa: "Footprint", proveedor: "Mi Cafetería", concepto: "Café", monto: 3.91, moneda: "USD", fecha: "2026-09-25", candidatos: [], lineas: [], chatId: 1, messageId: 1, creadoEn: 1, hayMovimientoBancario: true, movimientosAmbiguos: r } as unknown as PropuestaGasto;
    const textos = construirTecladoGasto(propuesta, opcionesTecladoDesdePropuesta(propuesta)).flat().map((b) => b.text);
    assert.ok(textos.some((t) => t.includes("Crear y conciliar")), "el cargo aprendido habilita crear y conciliar");
  }));

test("el aprendizaje no salta la política de categorías: un descriptor aprendido no legitima un cargo de categoría contradictoria", () =>
  conHolded([mov({ description: "Uber Eats" })], async () => {
    const deps = { aprendidas: async () => [aprendida("Uber Eats", "Uber")] };
    const r = await buscarMovimientoSimilar("Footprint", { monto: 3.91, fecha: "2026-09-25", moneda: "USD", proveedor: "Uber", concepto: "Traslado taxi", incluirPorConfirmar: true }, undefined, deps);
    assert.deepEqual(r, []);
  }));

test("la marca caduca: si luego se corrige el concepto y la categoría pasa a contradecir al cargo, ya no es utilizable", () => {
  const marcado = { descripcion: "Osteria Del Lovo", compatibilidad: "por_confirmar" as const };
  assert.equal(candidatoUtilizableParaGasto("Mi Cafetería", "Café", marcado), true);
  assert.equal(candidatoUtilizableParaGasto("Bolt", "Taxi aeropuerto", marcado), false);
});

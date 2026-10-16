import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ServicioConciliacionMultiple } from "../conciliacionMultiple/service";
import { TTL_PLAN, type CompraExacta, type MovimientoExacto, type PlanConciliacion, type PuertoHolded, type StorePlanes } from "../conciliacionMultiple/model";
import { crearHandlerLoteConciliaciones } from "./callback";
import { estadoLote, motivoDeExclusion, resumenLote, validarEntradaLote, type LoteConciliaciones } from "./model";
import { ServicioLoteConciliaciones } from "./service";
import type { StoreLotes } from "./store";

/**
 * El lote sobre el motor REAL de conciliación múltiple (solo Holded y los registros son dobles): lo que se prueba es la orquestación —
 * qué entra, revalidar todo antes de escribir, detenerse en el primer fallo, un solo botón— y que no existe otra vía de escritura.
 */
const compra = (id: string, proveedor: string, centimos: number, extra: Partial<CompraExacta> = {}): CompraExacta => ({
  id, proveedorId: `prov-${id}`, proveedor, numero: `N-${id}`, fecha: "2026-09-25", cuentasContables: ["gestoria"], moneda: "EUR", totalCentimos: centimos,
  pagadoCentimos: 0, pendienteCentimos: centimos, pagos: [], estado: "pending", borrador: false, ...extra,
});
const cargo = (movementId: string, centimos: number, extra: Partial<MovimientoExacto> = {}): MovimientoExacto => ({
  accountId: "main", movementId, fecha: "2026-10-15", descripcion: `Cargo ${movementId}`, cuenta: "Main", moneda: "EUR", centimos: -centimos, conciliadoCentimos: 0, estado: "pending", ...extra,
});

function fixture() {
  const compras = new Map<string, CompraExacta>([
    ["c1", compra("c1", "Cratevo", 21175)], ["c2", compra("c2", "Northgate", 46301)], ["c3", compra("c3", "Symbiosis", 750000)],
  ]);
  const movimientos: MovimientoExacto[] = [cargo("m1", 21175), cargo("m2", 46301, { fecha: "2026-10-09" }), cargo("m3", 750000, { fecha: "2026-10-07" })];
  const eventosPlanes: PlanConciliacion[] = [];
  const eventosLotes: LoteConciliaciones[] = [];
  const posts: string[] = [];
  const falloEn = new Set<string>();
  const registro = { llamadas: 0, fallarEn: new Set<number>() };
  const storePlanes: StorePlanes = {
    async listar() { return [...new Map(eventosPlanes.map((p) => [p.id, structuredClone(p)])).values()]; },
    async guardar(p) { eventosPlanes.push(structuredClone(p)); },
  };
  const storeLotes: StoreLotes = {
    async listar() { return [...new Map(eventosLotes.map((l) => [l.id, structuredClone(l)])).values()]; },
    async guardar(l) { registro.llamadas++; if (registro.fallarEn.has(registro.llamadas)) throw new Error("Sheets no disponible"); eventosLotes.push(structuredClone(l)); },
  };
  const holded: PuertoHolded = {
    async validarClasificacion() {},
    async compra(_e, id) { const c = compras.get(id); if (!c) throw new Error("Compra no encontrada"); return structuredClone(c); },
    async movimiento(_e, ref) { const m = movimientos.find((x) => x.movementId === ref.movementId && x.accountId === ref.accountId); if (!m) throw new Error("No encontrado"); return structuredClone(m); },
    async cerrarResiduoCambio() { return { estado: "sin_residuo" as const, montoCentimos: 0, motivo: "EUR" }; },
    async conciliar(_e, ref, compraId) {
      const c = compras.get(compraId)!; const m = movimientos.find((x) => x.movementId === ref.movementId)!;
      posts.push(ref.movementId);
      if (falloEn.has(ref.movementId)) return; // Holded responde 200 sin aplicar nada: el motor debe detectarlo al verificar.
      m.estado = "reconciled"; m.conciliadoCentimos = m.centimos;
      c.pagadoCentimos -= m.centimos; c.pendienteCentimos += m.centimos;
      c.pagos.push({ id: `pago-${m.movementId}`, centimos: -m.centimos, accountId: m.accountId, fecha: m.fecha });
    },
  };
  let ahora = 1_000;
  const motor = new ServicioConciliacionMultiple(holded, storePlanes, () => ahora);
  const servicio = new ServicioLoteConciliaciones(motor, holded, storeLotes, () => ahora);
  const pares = [
    { compraId: "c1", accountId: "main", movementId: "m1", fecha: "2026-10-15" },
    { compraId: "c2", accountId: "main", movementId: "m2", fecha: "2026-10-09" },
  ];
  return { registro, servicio, motor, holded, compras, movimientos, posts, falloEn, eventosPlanes, eventosLotes, pares, motivo: "Importe exacto, mismo proveedor y patrón mensual.",
    expirar() { ahora += TTL_PLAN + 1; } };
}
const preparar = (f: ReturnType<typeof fixture>, pares = f.pares) => f.servicio.preparar({ empresa: "Footprint", chatId: 7, pares, motivo: f.motivo });

test("un lote de dos pares se propone sin escribir nada y se concilia con un solo botón, verificando cada pago", async () => {
  const f = fixture();
  const lote = await preparar(f);
  assert.equal(lote.estado, "propuesto");
  assert.equal(lote.incluidos.length, 2);
  assert.equal(f.posts.length, 0, "proponer no escribe");
  assert.match(resumenLote(lote), /Cratevo — 211\.75 EUR/);
  assert.match(resumenLote(lote), /Northgate — 463\.01 EUR/);
  const hecho = await f.servicio.decidir(lote.id, 7, 99, true);
  assert.equal(hecho.estado, "completado");
  assert.deepEqual(f.posts, ["m1", "m2"], "uno a uno y en el orden del lote");
  assert.equal(f.compras.get("c1")!.pendienteCentimos, 0);
  assert.equal(f.compras.get("c2")!.pendienteCentimos, 0);
  assert.equal(hecho.aprobadoPor, 99);
  assert.ok(hecho.resultados.every((r) => r.estado === "completado"));
  assert.match(estadoLote(hecho), /conciliados y verificados en Holded: 2\/2/);
  assert.equal(f.eventosLotes.at(-1)!.estado, "completado");
});

test("lo que el lote no cubre queda fuera con su motivo exacto y el resto sigue", async () => {
  const f = fixture();
  f.compras.set("usd", compra("usd", "Kelly", 175000, { moneda: "USD" }));
  f.movimientos.push(cargo("mu", 177898, { moneda: "USD" }));
  f.compras.set("mayor", compra("mayor", "Hotel", 10000));
  f.movimientos.push(cargo("mm", 12898));
  f.compras.set("conpago", compra("conpago", "Pagada", 5000, { pagadoCentimos: 1000, pendienteCentimos: 4000, pagos: [{ id: "p0", centimos: 1000, accountId: "main", fecha: "2026-10-01" }] }));
  f.movimientos.push(cargo("mp", 4000));
  f.movimientos.push(cargo("mx", 21175, { estado: "reconciled", conciliadoCentimos: -21175 }));
  const todos = [...f.pares,
    { compraId: "usd", accountId: "main", movementId: "mu", fecha: "2026-10-15" },
    { compraId: "mayor", accountId: "main", movementId: "mm", fecha: "2026-10-15" },
    { compraId: "conpago", accountId: "main", movementId: "mp", fecha: "2026-10-15" }];
  const lote = await preparar(f, todos);
  assert.equal(lote.incluidos.length, 2);
  const motivos = Object.fromEntries(lote.excluidos.map((x) => [x.compraId, x.motivo]));
  assert.match(motivos.usd, /otra moneda/);
  assert.match(motivos.mayor, /MAYOR que el saldo/);
  assert.match(motivos.conpago, /ya tiene pagos/);
  assert.equal(f.posts.length, 0);
  assert.match(resumenLote(lote), /NO entran en el lote \(3\)/);
});

test("si ningún par entra, no hay lote ni planes y el error lo explica", async () => {
  const f = fixture();
  f.movimientos[0].estado = "reconciled"; f.movimientos[0].conciliadoCentimos = f.movimientos[0].centimos;
  await assert.rejects(() => preparar(f, [f.pares[0]]), /Ningún par entra en el lote[\s\S]*c1/);
  assert.equal(f.eventosLotes.length, 0);
});

test("la entrada se valida antes de leer Holded: tamaño, ids, fechas, evidencia y repeticiones", () => {
  const ok = [{ compraId: "c1", accountId: "main", movementId: "m1", fecha: "2026-10-15" }];
  assert.doesNotThrow(() => validarEntradaLote(ok, "evidencia"));
  assert.throws(() => validarEntradaLote([], "x"), /de 1 a 20/);
  assert.throws(() => validarEntradaLote(ok, "  "), /evidencia/);
  assert.throws(() => validarEntradaLote([{ ...ok[0], fecha: "15/10/2026" }], "x"), /YYYY-MM-DD/);
  assert.throws(() => validarEntradaLote([{ ...ok[0], compraId: "../x" }], "x"), /IDs? reales|compra_id/);
  assert.throws(() => validarEntradaLote([ok[0], { ...ok[0], movementId: "m9" }], "x"), /aparece dos veces/);
  assert.throws(() => validarEntradaLote([ok[0], { ...ok[0], compraId: "c9" }], "x"), /aparece dos veces/);
  assert.throws(() => validarEntradaLote(Array.from({ length: 21 }, (_, i) => ({ compraId: `c${i}`, accountId: "a", movementId: `m${i}`, fecha: "2026-10-15" })), "x"), /de 1 a 20/);
});

test("proponer dos veces el mismo lote devuelve el mismo; un cargo ya metido en otro lote vigente se rechaza", async () => {
  const f = fixture();
  const a = await preparar(f);
  const b = await preparar(f);
  assert.equal(b.id, a.id);
  assert.equal(f.eventosLotes.length, 1);
  await assert.rejects(() => preparar(f, [f.pares[0]]), /ya está en el lote|reservad/);
});

test("preflight de TODO el lote: si el segundo par cambió, no se escribe ni el primero y los planes se cancelan", async () => {
  const f = fixture();
  const lote = await preparar(f);
  f.compras.get("c2")!.totalCentimos += 100; f.compras.get("c2")!.pendienteCentimos += 100; // el gasto cambió después de proponer
  const r = await f.servicio.decidir(lote.id, 7, 99, true);
  assert.equal(r.estado, "rechazado");
  assert.equal(f.posts.length, 0, "ninguna escritura");
  assert.match(r.detalle ?? "", /No se envió ninguna conciliación/);
  assert.ok(f.eventosPlanes.filter((p) => p.estado === "cancelado").length >= 2, "ambos planes liberados");
});

test("se detiene en el primer fallo: lo verificado queda, el resto NO se envía y sus planes se cancelan", async () => {
  const f = fixture();
  f.compras.set("c3", compra("c3", "Symbiosis", 750000)); 
  const lote = await preparar(f, [...f.pares, { compraId: "c3", accountId: "main", movementId: "m3", fecha: "2026-10-07" }]);
  f.falloEn.add("m2"); // Holded acepta el POST del segundo par pero no aplica nada
  const r = await f.servicio.decidir(lote.id, 7, 99, true);
  assert.equal(r.estado, "incierto");
  assert.deepEqual(f.posts, ["m1", "m2"], "el tercer par jamás se envía");
  assert.deepEqual(r.resultados.map((x) => x.estado), ["completado", "incierto", "no_ejecutado"]);
  assert.equal(f.compras.get("c1")!.pendienteCentimos, 0, "el primero sí quedó conciliado");
  assert.equal(f.compras.get("c3")!.pendienteCentimos, 750000);
  assert.match(estadoLote(r), /No repetir ni dar por resuelto/);
});

test("doble clic, reinicio o reentrega: nunca repite una escritura", async () => {
  const f = fixture();
  const lote = await preparar(f);
  await Promise.all([f.servicio.decidir(lote.id, 7, 99, true), f.servicio.decidir(lote.id, 7, 99, true)]);
  assert.equal((await f.servicio.decidir(lote.id, 7, 99, true)).estado, "completado");
  assert.deepEqual(f.posts, ["m1", "m2"]);
});

test("cancelar libera los planes sin escribir; un lote caducado no se ejecuta; otro chat no lo ve", async () => {
  const f = fixture();
  const a = await preparar(f);
  const c = await f.servicio.decidir(a.id, 7, 99, false);
  assert.equal(c.estado, "cancelado");
  assert.equal(f.posts.length, 0);
  const b = await preparar(f); // tras cancelar, los mismos pares pueden proponerse de nuevo
  assert.notEqual(b.id, a.id);
  f.expirar();
  const e = await f.servicio.decidir(b.id, 7, 99, true);
  assert.equal(e.estado, "rechazado");
  assert.match(e.detalle ?? "", /expiró/);
  assert.equal(f.posts.length, 0);
  await assert.rejects(() => f.servicio.consultar(b.id, 8), /otro chat/);
});

test("motivoDeExclusion: el cargo exacto en EUR entra; todo lo demás explica por qué no", () => {
  assert.equal(motivoDeExclusion(compra("c", "P", 100), cargo("m", 100)), undefined);
  assert.match(motivoDeExclusion(compra("c", "P", 100), cargo("m", 90))!, /exactamente/);
  assert.match(motivoDeExclusion(compra("c", "P", 100), cargo("m", 110))!, /MAYOR/);
  assert.match(motivoDeExclusion(compra("c", "P", 100, { moneda: "COP" }), cargo("m", 100, { moneda: "COP" }))!, /otra moneda/);
});

test("el botón exige superadministrador, valida el dato y responde con el estado real del lote", async () => {
  const enviados: string[] = [], respuestas: string[] = [];
  const llamadas: unknown[][] = [];
  const lote = { id: "L1", empresa: "Footprint", chatId: 7, creadoEn: 1, motivo: "m", estado: "completado", incluidos: [], excluidos: [], resultados: [] } as unknown as LoteConciliaciones;
  const manejar = (puede: boolean) => crearHandlerLoteConciliaciones({
    servicio: { decidir: async (...a: unknown[]) => { llamadas.push(a); return lote; } } as never,
    puedeAprobar: async () => puede, responder: async (_i, t) => { respuestas.push(t); }, enviar: async (_c, t) => { enviados.push(t); },
  });
  const cb = (data: string) => ({ id: "cb", data, from: { id: 5 }, message: { chat: { id: 7 } } }) as never;
  await manejar(false)(cb("loteconcil_si:L1"));
  assert.equal(llamadas.length, 0);
  assert.match(respuestas.at(-1)!, /superadministrador/);
  await manejar(true)(cb("loteconcil_si:L1:extra"));
  assert.equal(llamadas.length, 0);
  await manejar(true)(cb("loteconcil_si:L1"));
  assert.deepEqual(llamadas[0], ["L1", 7, 5, true]);
  assert.match(enviados.at(-1)!, /Lote L1: completado/);
  await manejar(true)(cb("loteconcil_no:L1"));
  assert.deepEqual(llamadas[1], ["L1", 7, 5, false]);
});

test("no existe otra vía de escritura: el lote solo habla con el motor de planes y con lecturas", () => {
  const dir = join(process.cwd(), "core/holded/loteConciliaciones");
  for (const archivo of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    const fuente = readFileSync(join(dir, archivo), "utf8");
    assert.doesNotMatch(fuente, /holdedWriteCall|reconciliarMovimiento|\/reconcile|editarCompraHolded/, `${archivo} escribe en Holded por su cuenta`);
  }
  const servicio = readFileSync(join(dir, "service.ts"), "utf8");
  assert.match(servicio, /this\.motor\.decidir\(/);
});

test("si falla el registro del lote entre dos pares: lo conciliado queda, el resto NO se envía y el estado dice la verdad", async () => {
  const f = fixture();
  f.compras.set("c3", compra("c3", "Symbiosis", 750000));
  const lote = await preparar(f, [...f.pares, { compraId: "c3", accountId: "main", movementId: "m3", fecha: "2026-10-07" }]);
  f.registro.fallarEn.add(f.registro.llamadas + 2); // guardar «ejecutando» (+1) y tras el par 1 (+2)
  const r = await f.servicio.decidir(lote.id, 7, 99, true);
  assert.equal(r.estado, "incierto");
  assert.deepEqual(f.posts, ["m1"], "ningún par más tras el fallo del registro");
  assert.deepEqual(r.resultados.map((x) => x.estado), ["completado", "no_ejecutado", "no_ejecutado"]);
  assert.match(estadoLote(r), /No repetir ni dar por resuelto/);
  assert.ok(f.eventosPlanes.filter((p) => p.estado === "cancelado").length >= 2, "los planes no enviados quedan libres");
  // los pares no enviados pueden proponerse de nuevo (el lote detenido ya no los reserva)
  const nuevo = await preparar(f, [f.pares[1]]);
  assert.equal(nuevo.incluidos.length, 1);
});

test("un lote en curso dice que puede haber pagos aplicados y no promete «0 conciliado»", () => {
  const l = { id: "L", empresa: "Footprint", chatId: 7, creadoEn: 1, motivo: "m", estado: "ejecutando", incluidos: [], excluidos: [], resultados: [] } as unknown as LoteConciliaciones;
  assert.match(estadoLote(l), /en curso o se interrumpió[\s\S]*No repetir/);
  assert.doesNotMatch(estadoLote(l), /Pendiente de aprobación/);
});

test("un plan de otro origen no se adopta ni se cancela: el par queda fuera con su motivo", async () => {
  const f = fixture();
  const ajeno = await f.motor.preparar({ empresa: "Footprint", chatId: 7, compraId: "c1", movimientos: [{ accountId: "main", movementId: "m1", fecha: "2026-10-15" }], motivo: "declaración", origen: { tipo: "declaracion", id: "d1" } });
  const lote = await preparar(f);
  assert.equal(lote.incluidos.length, 1);
  assert.match(lote.excluidos[0].motivo, /otro origen/);
  assert.equal((await f.motor.consultar(ajeno.id, 7)).estado, "propuesto", "el plan ajeno sigue intacto");
  const r = await f.servicio.decidir(lote.id, 7, 99, true);
  assert.equal(r.estado, "completado");
  assert.equal((await f.motor.consultar(ajeno.id, 7)).estado, "propuesto", "aprobar el lote tampoco lo toca");
});

test("un plan huérfano de un lote que no llegó a registrarse se limpia y se vuelve a preparar", async () => {
  const f = fixture();
  const huerfano = await f.motor.preparar({ empresa: "Footprint", chatId: 7, compraId: "c1", movimientos: [{ accountId: "main", movementId: "m1", fecha: "2026-10-15" }], motivo: "x", origen: { tipo: "lote", id: "fantasma" } });
  const lote = await preparar(f, [f.pares[0]]);
  assert.equal(lote.incluidos.length, 1);
  assert.notEqual(lote.incluidos[0].planId, huerfano.id);
  assert.equal((await f.motor.consultar(huerfano.id, 7)).estado, "cancelado");
});

test("repetir la misma petición con un par excluido devuelve el mismo lote", async () => {
  const f = fixture();
  f.compras.set("usd", compra("usd", "Kelly", 175000, { moneda: "USD" }));
  f.movimientos.push(cargo("mu", 177898, { moneda: "USD" }));
  const pares = [...f.pares, { compraId: "usd", accountId: "main", movementId: "mu", fecha: "2026-10-15" }];
  const a = await preparar(f, pares);
  const b = await preparar(f, pares);
  assert.equal(b.id, a.id);
});

test("el motor no revalida un plan caducado", async () => {
  const f = fixture();
  const lote = await preparar(f);
  f.expirar();
  const r = await f.motor.revalidar(lote.incluidos[0].planId, 7);
  assert.deepEqual(r, { ok: false, motivo: "la propuesta expiró" });
});


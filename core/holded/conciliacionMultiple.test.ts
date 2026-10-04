import assert from "node:assert/strict";
import test from "node:test";
import { ServicioConciliacionMultiple } from "./conciliacionMultiple/service";
import { HoldedConciliacionAdapter } from "./conciliacionMultiple/holdedAdapter";
import { centimos, importe, validarSeleccion, reservaActiva, TTL_PLAN, type CompraExacta, type MovimientoExacto, type PlanConciliacion, type StorePlanes, type PuertoHolded } from "./conciliacionMultiple/model";

const compraBase: CompraExacta = {
  id: "gora-compra", proveedorId: "gora", proveedor: "Gora World Group LLC", numero: "991", fecha: "2026-09-16",
  cuentasContables: ["servicios"], moneda: "EUR", totalCentimos: 320000, pagadoCentimos: 0, pendienteCentimos: 320000, pagos: [], estado: "pending", borrador: false,
};
const movimientosBase: MovimientoExacto[] = [100000, 100000, 20000, 100000].map((n, i) => ({
  accountId: i === 3 ? "bank-2" : "bank-1", movementId: `mov-${i}`, fecha: ["2026-08-14", "2026-09-01", "2026-09-07", "2026-09-16"][i],
  descripcion: "GORA", cuenta: "Banco", moneda: "EUR", centimos: -n, conciliadoCentimos: 0, estado: "pending",
}));
function fixture() {
  let compra = structuredClone(compraBase);
  const movimientos = structuredClone(movimientosBase);
  const eventos: PlanConciliacion[] = [];
  const posts: string[] = [];
  const store: StorePlanes = {
    async listar() { return [...new Map(eventos.map((p) => [p.id, structuredClone(p)])).values()]; },
    async guardar(p) { eventos.push(structuredClone(p)); },
  };
  const holded: PuertoHolded = {
    async validarClasificacion() {},
    async compra() { return structuredClone(compra); },
    async movimiento(_empresa, ref) {
      const m = movimientos.find((m) => m.movementId === ref.movementId && m.accountId === ref.accountId);
      if (!m) throw new Error("No encontrado");
      return structuredClone(m);
    },
    async conciliar(_empresa, ref, id) {
      assert.equal(id, compra.id);
      const m = movimientos.find((m) => m.movementId === ref.movementId)!;
      assert.equal(m.estado, "pending");
      posts.push(ref.movementId);
      assert.equal(eventos.at(-1)?.estado, "ejecutando");
      assert.equal(eventos.at(-1)?.enVuelo, `${ref.accountId}/${ref.movementId}`);
      m.estado = "reconciled";
      m.conciliadoCentimos = m.centimos;
      compra.pagadoCentimos -= m.centimos;
      compra.pendienteCentimos += m.centimos;
      compra.pagos.push({ id: `pago-${m.movementId}`, centimos: -m.centimos, accountId: m.accountId, fecha: m.fecha });
    },
  };
  let ahora = 1000;
  const servicio = new ServicioConciliacionMultiple(holded, store, () => ahora);
  const datos = { empresa: "EWORKS" as const, chatId: 123, compraId: compra.id, movimientos, motivo: "Cuatro pagos identificados de Gora para factura 991." };
  return { servicio, datos, holded, store, posts, eventos, movimientos, get compra() { return compra; }, set compra(c) { compra = c; }, expirar() { ahora += TTL_PLAN + 1; } };
}

test("céntimos exactos y formatos de Holded; nunca redondea ni acepta datos ambiguos", () => {
  assert.equal(centimos("3.200,00", true), 320000);
  assert.equal(centimos("3200.00", true), 320000);
  assert.equal(centimos("-1000.00"), -100000);
  assert.equal(centimos(0.1) + centimos(0.2), centimos(0.3));
  assert.equal(importe(-1), "-0.01");
  for (const raw of [null, undefined, "", " ", "1e2", "1.000", "1,000.00", "1,2,3", "NaN", Infinity, 0.1 + 0.2, "9007199254740991.99"]) {
    assert.throws(() => centimos(raw));
  }
});
test("Gora: cuatro pagos contra un gasto, distintas fechas y cuentas; verificación completa", async () => {
  const f = fixture();
  const plan = await f.servicio.preparar(f.datos);
  assert.equal(f.posts.length, 0);
  assert.equal(plan.compra.totalCentimos, 320000);
  const resultado = await f.servicio.decidir(plan.id, 123, 9, true);
  assert.equal(resultado.estado, "completado");
  assert.equal(resultado.verificados.length, 4);
  assert.equal(f.compra.pendienteCentimos, 0);
  assert.deepEqual(f.posts, ["mov-0", "mov-1", "mov-2", "mov-3"]);
  assert.equal(resultado.aprobadoPor, 9);
  assert.equal(f.eventos.at(-1)?.estado, "completado");
});
test("puede cerrar el saldo de una compra que ya tenía pagos verificados", async () => {
  const f = fixture();
  f.compra.totalCentimos += 50000;
  f.compra.pagadoCentimos = 50000;
  f.compra.pagos.push({ id: "anterior", centimos: 50000, accountId: "bank-1", fecha: "2026-08-01" });
  const p = await f.servicio.preparar(f.datos);
  assert.equal((await f.servicio.decidir(p.id, 123, 9, true)).estado, "completado");
  assert.equal(f.compra.pagos.length, 5);
});
for (const [caso, alterar] of Object.entries<(f: ReturnType<typeof fixture>) => void>({
  centimoFaltante: (f) => { f.movimientos[0].centimos += 1; },
  centimoSobrante: (f) => { f.movimientos[0].centimos -= 1; },
  divisa: (f) => { f.movimientos[0].moneda = "USD"; },
  compraDivisa: (f) => { f.compra.moneda = "USD"; },
  abono: (f) => { f.movimientos[0].centimos = 100000; },
  parcial: (f) => { f.movimientos[0].estado = "partial"; },
  importeConciliado: (f) => { f.movimientos[0].conciliadoCentimos = -1; },
  estadoDesconocido: (f) => { f.movimientos[0].estado = ""; },
  borrador: (f) => { f.compra.borrador = true; },
  anulada: (f) => { f.compra.estado = "cancelled"; },
  saldosInconsistentes: (f) => { f.compra.pagadoCentimos = 1; },
  proveedorAusente: (f) => { f.compra.proveedorId = ""; },
})) {
  test(`bloquea ${caso} antes de cualquier POST`, async () => {
    const f = fixture(); alterar(f);
    await assert.rejects(() => f.servicio.preparar(f.datos));
    assert.equal(f.posts.length, 0);
  });
}
test("rechaza IDs repetidos incluso si la suma aparenta cuadrar", () => {
  const movs = structuredClone(movimientosBase);
  movs[1].movementId = movs[0].movementId;
  assert.throws(() => validarSeleccion(compraBase, movs), /duplicados/);
});
test("preflight de TODO el lote: cambio en el último movimiento impide tocar el primero", async () => {
  const f = fixture(); const p = await f.servicio.preparar(f.datos);
  f.movimientos[3].estado = "reconciled";
  assert.equal((await f.servicio.decidir(p.id, 123, 9, true)).estado, "rechazado");
  assert.equal(f.posts.length, 0);
});
test("rechaza cambios en identidad del documento y saldo después de proponer", async () => {
  const f = fixture(); const p = await f.servicio.preparar(f.datos);
  f.compra.proveedorId = "otro-proveedor";
  assert.equal((await f.servicio.decidir(p.id, 123, 9, true)).estado, "rechazado");
  assert.equal(f.posts.length, 0);
});
test("doble clic simultáneo y reentrega tras reinicio producen un solo lote", async () => {
  const f = fixture(); const p = await f.servicio.preparar(f.datos);
  const res = await Promise.all([f.servicio.decidir(p.id, 123, 9, true), f.servicio.decidir(p.id, 123, 9, true)]);
  assert.ok(res.every((r) => r.estado === "completado"));
  const reinicio = new ServicioConciliacionMultiple(f.holded, f.store);
  await reinicio.decidir(p.id, 123, 9, true);
  assert.equal(f.posts.length, 4);
});
test("timeout después de aplicar segundo pago: detiene, conserva evidencia y no repite", async () => {
  const f = fixture(); const p = await f.servicio.preparar(f.datos);
  const original = f.holded.conciliar;
  f.holded.conciliar = async (...args) => { await original(...args); if (f.posts.length === 2) throw new Error("timeout"); };
  const r = await f.servicio.decidir(p.id, 123, 9, true);
  assert.equal(r.estado, "incierto");
  assert.equal(r.verificados.length, 1);
  assert.equal(r.enVuelo, "bank-1/mov-1");
  const reinicio = new ServicioConciliacionMultiple(f.holded, f.store);
  await reinicio.decidir(p.id, 123, 9, true);
  await assert.rejects(() => reinicio.preparar(f.datos), /reservados/);
  assert.equal(f.posts.length, 2);
});
test("un 200 sin efecto real jamás cuenta como éxito y detiene el lote", async () => {
  const f = fixture(); const p = await f.servicio.preparar(f.datos);
  f.holded.conciliar = async () => { f.posts.push("POST-sin-efecto"); };
  const r = await f.servicio.decidir(p.id, 123, 9, true);
  assert.equal(r.estado, "incierto"); assert.equal(r.verificados.length, 0); assert.equal(f.posts.length, 1);
});
test("saldo correcto sin nuevo pago en la cuenta correcta no confirma la conciliación", async () => {
  const f = fixture(); const p = await f.servicio.preparar(f.datos);
  const original = f.holded.conciliar;
  f.holded.conciliar = async (...args) => { await original(...args); f.compra.pagos.at(-1)!.accountId = "otro-banco"; };
  const r = await f.servicio.decidir(p.id, 123, 9, true);
  assert.equal(r.estado, "incierto"); assert.equal(r.verificados.length, 0); assert.equal(f.posts.length, 1);
});
test("fallo de persistencia antes del POST impide escribir", async () => {
  const f = fixture(); const p = await f.servicio.preparar(f.datos);
  f.store.guardar = async () => { throw new Error("Sheets inaccesible"); };
  await assert.rejects(() => f.servicio.decidir(p.id, 123, 9, true)); assert.equal(f.posts.length, 0);
});
test("fallo de persistencia tras POST deja bloqueo durable para el reinicio", async () => {
  const f = fixture(); const p = await f.servicio.preparar(f.datos);
  const save = f.store.guardar;
  f.store.guardar = async (p) => { if (f.posts.length) throw new Error("Sheets inaccesible"); await save(p); };
  await assert.rejects(() => f.servicio.decidir(p.id, 123, 9, true));
  assert.equal(f.eventos.at(-1)!.estado, "ejecutando");
  f.store.guardar = save;
  await new ServicioConciliacionMultiple(f.holded, f.store).decidir(p.id, 123, 9, true);
  assert.equal(f.posts.length, 1);
});
test("cancelación, expiración y chat ajeno no escriben en Holded", async () => {
  const f = fixture(); const p = await f.servicio.preparar(f.datos);
  await assert.rejects(() => f.servicio.decidir(p.id, 999, 9, true));
  assert.equal((await f.servicio.decidir(p.id, 123, 9, false)).estado, "cancelado");
  const p2 = await f.servicio.preparar(f.datos); f.expirar();
  assert.equal((await f.servicio.decidir(p2.id, 123, 9, true)).estado, "rechazado");
  assert.equal(f.posts.length, 0);
});
test("reutiliza propuesta idéntica y bloquea reserva cruzada entre facturas", async () => {
  const f = fixture(); const p = await f.servicio.preparar(f.datos);
  assert.equal((await f.servicio.preparar({ ...f.datos, movimientos: [...f.movimientos].reverse() })).id, p.id);
  await assert.rejects(() => f.servicio.preparar({ ...f.datos, compraId: "otra-factura" }), /reservados/);
  assert.equal(f.eventos.length, 1);
  assert.equal(reservaActiva({ ...p, estado: "incierto" }, Date.now() + TTL_PLAN * 2), true);
});
test("adaptador recorre cursores; usa IDs exactos y no confunde fecha valor con booking", async () => {
  process.env.HOLDED_API_KEY_EWORKS = "test-read";
  const urls: string[] = [];
  const adapter = new HoldedConciliacionAdapter(async (url) => {
    urls.push(String(url));
    if (!String(url).includes("bank-movements")) return Response.json({ id: "bank-1", name: "Banco", currency: "EUR" });
    if (!String(url).includes("cursor=")) return Response.json({ items: [], has_more: true, cursor: "pagina2" });
    return Response.json({ items: [{ id: "mov-0", banking_account_id: "bank-1", booking_date: "2026-08-14T00:00:00Z", value_date: "2026-08-17", amount: "-1000.00", reconciled_amount: "0.00", status: "pending", currency: "EUR" }], has_more: false });
  });
  const m = await adapter.movimiento("EWORKS", movimientosBase[0]);
  assert.equal(m.centimos, -100000); assert.equal(urls.length, 3);
  assert.ok(!urls.some((url) => url.includes("start_date=")));
});
test("adaptador POST usa documents y nunca reintenta una respuesta fallida", async () => {
  process.env.HOLDED_API_KEY_WRITE_EWORKS = "test-write";
  let llamadas = 0;
  const adapter = new HoldedConciliacionAdapter(async (_url, init) => {
    llamadas++;
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), { documents: [{ document_id: "gora-compra", document_type: "purchase" }] });
    return new Response("", { status: 429 });
  });
  await assert.rejects(() => adapter.conciliar("EWORKS", movimientosBase[0], "gora-compra"));
  assert.equal(llamadas, 1);
});

test("cada paso persiste el ID del pago y el saldo de compra verificados", async () => {
  const f = fixture(); const p = await f.servicio.preparar(f.datos);
  const r = await f.servicio.decidir(p.id, 123, 9, true);
  assert.deepEqual(r.pagosVerificados.map((v) => v.pendienteCentimos), [220000, 120000, 100000, 0]);
  assert.deepEqual(r.pagosVerificados.map((v) => v.pago.id), ["pago-mov-0", "pago-mov-1", "pago-mov-2", "pago-mov-3"]);
});
test("relectura final detecta un movimiento anterior desconciliado durante el lote", async () => {
  const f = fixture(); const p = await f.servicio.preparar(f.datos);
  const original = f.holded.conciliar;
  f.holded.conciliar = async (...args) => {
    await original(...args);
    if (f.posts.length === 4) f.movimientos[0].estado = "pending";
  };
  assert.equal((await f.servicio.decidir(p.id, 123, 9, true)).estado, "incierto");
});
test("adaptador admite importes ES y decimales, rechaza borradores y detalle ausente", async () => {
  process.env.HOLDED_API_KEY_EWORKS = "test-read";
  const raw: Record<string, unknown> = { id: "gora-compra", contact_id: "gora", contact_name: "Gora", document_number: "991", date: "2026-09-16",
    lines: [{ account: "servicios" }], currency: "EUR", total: "3.200,00", payments_total: "0.00", payments_pending: "3200.00", payments_detail: [], draft: false, status: "pending" };
  const adapter = new HoldedConciliacionAdapter(async () => Response.json(raw));
  assert.equal((await adapter.compra("EWORKS", "gora-compra")).totalCentimos, 320000);
  raw.draft = true;
  await assert.rejects(() => adapter.compra("EWORKS", "gora-compra"), /contabilizada/);
  raw.draft = false; delete raw.payments_detail;
  await assert.rejects(() => adapter.compra("EWORKS", "gora-compra"), /detalle/);
});
test("adaptador rechaza paginación rota, cuenta equivocada y moneda ausente", async () => {
  process.env.HOLDED_API_KEY_EWORKS = "test-read";
  const raw = { items: [] as Record<string, unknown>[], has_more: true };
  const adapter = new HoldedConciliacionAdapter(async (url) => Response.json(String(url).includes("bank-movements") ? raw : { id: "bank-1", name: "Banco", currency: "EUR" }));
  await assert.rejects(() => adapter.movimiento("EWORKS", movimientosBase[0]), /Paginación/);
  raw.items = [{ id: "mov-0", banking_account_id: "otra-cuenta" }];
  await assert.rejects(() => adapter.movimiento("EWORKS", movimientosBase[0]), /cuenta/);
  raw.items = [{ id: "mov-0", banking_account_id: "bank-1", booking_date: "2026-08-14" }];
  await assert.rejects(() => adapter.movimiento("EWORKS", movimientosBase[0]), /moneda/);
});

test("cuenta contable no validada bloquea el lote antes de proponer o escribir", async () => {
  const f = fixture();
  f.holded.validarClasificacion = async () => { throw new Error("Anthropic no puede ir a viajes"); };
  await assert.rejects(() => f.servicio.preparar(f.datos), /viajes/);
  assert.equal(f.posts.length, 0);
});
test("cambio de clasificación tras aprobación detiene el lote", async () => {
  const f = fixture(); const p = await f.servicio.preparar(f.datos);
  f.holded.validarClasificacion = async () => { throw new Error("Cuenta modificada"); };
  assert.equal((await f.servicio.decidir(p.id, 123, 9, true)).estado, "rechazado");
  assert.equal(f.posts.length, 0);
});

// ── Moneda distinta del euro: solo con habilitación explícita y SIN conversión (caso Uber Footprint 28/09/2026: 8,95 USD = 6,91 + 2,04) ──
const compraUber: CompraExacta = { ...compraBase, id: "uber", proveedor: "Uber", moneda: "USD", totalCentimos: 895, pendienteCentimos: 895, numero: "-" };
const movUber = (n: number, id: string, moneda = "USD"): MovimientoExacto => ({ accountId: "ftg-usd", movementId: id, fecha: "2026-09-28", descripcion: "Uber Pending", cuenta: "FTG USD", moneda, centimos: -n, conciliadoCentimos: 0, estado: "pending" });

test("USD: por defecto NO está habilitado (solo EUR); con la variable explícita sí, con suma exacta y misma moneda", () => {
  const prev = process.env.WOBI_CONCILIACION_MULTIPLE_MONEDAS;
  try {
    delete process.env.WOBI_CONCILIACION_MULTIPLE_MONEDAS;
    assert.throws(() => validarSeleccion(compraUber, [movUber(691, "a"), movUber(204, "b")]), /no está habilitada para USD/);
    process.env.WOBI_CONCILIACION_MULTIPLE_MONEDAS = "EUR,USD";
    assert.doesNotThrow(() => validarSeleccion(compraUber, [movUber(691, "a"), movUber(204, "b")])); // 6,91 + 2,04 = 8,95 exacto
    assert.throws(() => validarSeleccion(compraUber, [movUber(691, "a"), movUber(205, "b")]), /debe coincidir exactamente/); // un céntimo de más: no
    assert.throws(() => validarSeleccion(compraUber, [movUber(691, "a"), movUber(204, "b", "EUR")]), /monedas no coinciden/i); // sin conversión
  } finally { if (prev === undefined) delete process.env.WOBI_CONCILIACION_MULTIPLE_MONEDAS; else process.env.WOBI_CONCILIACION_MULTIPLE_MONEDAS = prev; }
});

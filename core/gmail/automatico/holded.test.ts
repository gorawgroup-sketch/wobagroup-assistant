import assert from "node:assert/strict";
import test from "node:test";
import { HoldedAuto, normalizarProveedorExacto, type MemoriaHoldedAuto } from "./holded";
import { evaluarAuto, hash, type OperacionAuto } from "./model";
import { analisisFixture, configFixture, correoFixture, evidenciaFixture, reciboFixture } from "./fixtures";

function escenario() {
  process.env.HOLDED_API_KEY_WOBA = "test-not-a-secret";
  process.env.HOLDED_API_KEY_WRITE_WOBA = "test-not-a-secret";
  const c = correoFixture(), r = reciboFixture();
  const posts: Array<{ path: string; body: unknown }> = [];
  const compra = { id: "creada", document_number: "R-1", contact_id: "p1", currency: "EUR", date: r.fecha, total: "20.00", tax: "0.00",
    lines: [{ account: "c1" }], tags: ["wobi-auto-op1"], payments_total: "0", payments_pending: "20.00", payments_detail: [] as unknown[], draft: true };
  const movimiento = { id: "b1", banking_account_id: "a1", currency: "EUR", amount: "-20.00", reconciled_amount: "0.00", booking_date: r.fecha,
    status: "pending", description: "Proveedor", origin: "bank" };
  const contactos = [{ id: "p1", name: "Proveedor" }];
  let attachment: { id: string } | undefined;
  const memoria: MemoriaHoldedAuto = { alias: async () => [], duplicadoInterno: async () => false,
    cuentaConfirmada: async () => ({ cuentaId: "c1", confirmadoEn: new Date().toISOString() }) };
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
  const list = (items: unknown[]) => json({ items, has_more: false, cursor: null });
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); const path = url.pathname.replace("/api/v2", "");
    if (init?.method === "POST") {
      const body = init.body instanceof FormData ? init.body : JSON.parse(String(init.body));
      posts.push({ path, body });
      if (path === "/purchases") return json({ id: "creada" });
      if (path.endsWith("/attachments")) { const file = (init.body as FormData).get("file") as File; attachment = { id: file.name }; return json({}); }
      throw new Error(`POST no esperado ${path}`);
    }
    if (path === "/contacts") return list(contactos);
    if (path === "/purchases") return list([]);
    if (path === "/expenses-accounts") return json({ items: [{ id: "c1", name: "Servicios", archived: false }] });
    if (path === "/treasury/accounts") return list([{ id: "a1", name: "Cuenta", currency: "EUR", archived: false }]);
    if (path === "/treasury/accounts/a1") return json({ id: "a1", currency: "EUR", archived: false });
    if (path.endsWith("/bank-movements")) return list([movimiento]);
    if (path === "/purchases/creada") return json(compra);
    if (path.endsWith("/attachments")) return list(attachment ? [attachment] : []);
    if (path.includes("/attachments/")) return new Response(c.cuerpo);
    throw new Error(`GET no esperado ${path}`);
  };
  const adapter = new HoldedAuto(memoria, request);
  const d = evaluarAuto(c, analisisFixture(), r, evidenciaFixture(), configFixture); assert.ok(d.apto);
  const op: OperacionAuto = { id: "op1", plan: d.plan, estado: "creando" };
  return { adapter, request, memoria, compra, movimiento, contactos, posts, c, r, op };
}
test("consulta proveedor exacto, catálogo no paginado, memoria y cargo real", async () => {
  const e = escenario(); const ev = await e.adapter.evidencias(e.c, e.r);
  assert.equal(ev.consultasCompletas, true); assert.equal(ev.contacto?.id, "p1"); assert.equal(ev.cuenta?.id, "c1");
  assert.equal(ev.permiteTicket, true); assert.equal(ev.movimientos[0].origen, "bank");
});
test("consulta evidencias deterministas para una clasificación media y permite reforzarla", async () => {
  const e = escenario(); e.r.confianza = "media";
  const ev = await e.adapter.evidencias(e.c, e.r);
  assert.equal(ev.consultasCompletas, true);
  assert.equal(ev.contacto?.id, "p1");
  assert.equal(ev.movimientos.length, 1);
});
test("detecta empresa desconocida solo si un Holded tiene contacto y movimiento exactos", async () => {
  const e = escenario(); e.r.empresa = "desconocida";
  const adapter = new HoldedAuto(e.memoria, e.request, ["WOBA"]);
  const ev = await adapter.evidencias(e.c, e.r);
  assert.equal(ev.empresaDetectada, "WOBA");
  assert.equal(ev.contacto?.id, "p1");
  assert.equal(ev.movimientos.length, 1);
});
test("crear usa la compra en borrador, sin IVA, con cuenta y marcador recuperable", async () => {
  const e = escenario(); e.op.compraId = await e.adapter.crear(e.op);
  assert.equal(e.op.compraId, "creada"); assert.equal(e.posts.length, 1);
  const body = e.posts[0].body as Record<string, unknown>;
  assert.equal(body.draft, true); assert.equal(body.contact_id, "p1"); assert.equal(body.currency, "EUR");
  assert.deepEqual((body.items as unknown[])[0], { name: "Transporte", units: 1, price: 20, taxes: [], account: "c1" });
  assert.equal(await e.adapter.verificarCreacion(e.op), true);
  e.compra.total = "21.00"; assert.equal(await e.adapter.verificarCreacion(e.op), false);
});
test("crear un borrador sin cuenta inferida no agrega una cuenta inventada", async () => {
  const e = escenario(); e.op.plan.cuentaId = undefined;
  e.op.compraId = await e.adapter.crear(e.op);
  const body = e.posts[0].body as Record<string, unknown>;
  assert.deepEqual((body.items as unknown[])[0], { name: "Transporte", units: 1, price: 20, taxes: [] });
  assert.equal(await e.adapter.verificarCreacion(e.op), true);
});
test("las variantes inequívocas de forma societaria conservan coincidencia exacta", () => {
  assert.equal(normalizarProveedorExacto("OUIGO ESPAÑA S.A.U."), normalizarProveedorExacto("OUIGO ESPAÑA SA."));
  assert.equal(normalizarProveedorExacto("Nieuwe Veste (Restaurant, Breda)"), normalizarProveedorExacto("Nieuwe Veste"));
  assert.notEqual(normalizarProveedorExacto("DHL"), normalizarProveedorExacto("DHL Express Spain SLU"));
});
test("resuelve un proveedor abreviado solo si el contacto es único y el banco lo confirma", async () => {
  const e = escenario();
  e.r.proveedor = "DHL";
  e.contactos[0].name = "DHL Express Spain SLU";
  e.movimiento.description = "DHL EXPRESS COMPRA 1234";
  e.movimiento.booking_date = "2026-09-13";
  e.movimiento.amount = "-19.75";
  const evidencia = await e.adapter.evidencias(e.c, e.r);
  assert.equal(evidencia.contacto?.metodo, "aproximado_unico");
  assert.equal(evidencia.contacto?.exacto, false);
  const decision = evaluarAuto(e.c, analisisFixture(e.r), e.r, evidencia, configFixture);
  assert.equal(decision.apto, true);
  if (decision.apto) assert.equal(decision.plan.totalCentimos, 1975);
});
test("dos contactos aproximados continúan en revisión manual", async () => {
  const e = escenario();
  e.r.proveedor = "DHL";
  e.contactos.splice(0, 1, { id: "p1", name: "DHL Express Spain SLU" }, { id: "p2", name: "DHL Freight Spain SLU" });
  const evidencia = await e.adapter.evidencias(e.c, e.r);
  assert.equal(evidencia.contacto, undefined);
});
test("comprobante verificado por contenido binario y sin reconstruir un adjunto real", async () => {
  const e = escenario(); e.op.compraId = "creada";
  await e.adapter.adjuntar(e.op, e.c);
  assert.equal(await e.adapter.verificarAdjunto(e.op), true);
  e.op.plan.fuenteHash = hash("otro archivo");
  assert.equal(await e.adapter.verificarAdjunto(e.op), false);
  await assert.rejects(() => e.adapter.adjuntar(e.op, e.c), /comprobante cambió/);
});
test("acepta estados finales reales y rechaza importe parcial o saldo pendiente", async () => {
  const e = escenario(); e.op.compraId = "creada";
  e.compra.payments_total = "20.00"; e.compra.payments_pending = "0";
  e.compra.payments_detail = [{ id: "pay", bank_id: "a1", amount: "20.00", date: e.r.fecha }];
  e.movimiento.status = "reconciled"; e.movimiento.reconciled_amount = "-20.00";
  assert.equal(await e.adapter.verificarConciliacion(e.op), true);
  e.movimiento.status = "forced_reconciled";
  assert.equal(await e.adapter.verificarConciliacion(e.op), true);
  e.movimiento.status = "reconciled"; e.compra.payments_pending = "0.01";
  assert.equal(await e.adapter.verificarConciliacion(e.op), false);
  e.compra.payments_pending = "0"; e.movimiento.reconciled_amount = "-10.00";
  assert.equal(await e.adapter.verificarConciliacion(e.op), false);
});
test("alias contradictorios y respuestas paginadas incompletas no autorizan", async () => {
  const e = escenario(); e.memoria.alias = async () => [{ contactId: "p1", contactName: "Proveedor" }, { contactId: "p2", contactName: "Otro" }];
  assert.equal((await e.adapter.evidencias(e.c, e.r)).contacto, undefined);
  const broken = new HoldedAuto(e.memoria, async () => new Response(JSON.stringify({ items: [] })));
  await assert.rejects(() => broken.listar("WOBA", "/contacts"), /Paginación/);
});
test("un HTTP ambiguo no provoca reintento automático de POST", async () => {
  const e = escenario(); let intentos = 0;
  const broken = new HoldedAuto(e.memoria, async () => { intentos++; return new Response("", { status: 503 }); });
  await assert.rejects(() => broken.crear(e.op), /no se repetirá/);
  assert.equal(intentos, 1);
});

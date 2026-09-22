import assert from "node:assert/strict";
import test from "node:test";
import { HoldedAuto, normalizarProveedorExacto, type FlujoGastoExistente, type MemoriaHoldedAuto } from "./holded";
import { evaluarAuto, hash, monedaRegistroPlanAuto, type OperacionAuto } from "./model";
import { analisisFixture, configFixture, correoFixture, evidenciaFixture, reciboFixture } from "./fixtures";

function escenario() {
  process.env.HOLDED_API_KEY_WOBA = "test-not-a-secret";
  process.env.HOLDED_API_KEY_WRITE_WOBA = "test-not-a-secret";
  const c = correoFixture(), r = reciboFixture();
  const posts: Array<{ path: string; body: unknown }> = [];
  const compra = { id: "creada", document_number: "R-1", contact_id: "p1", currency: "EUR", date: r.fecha, total: "20.00", tax: "0.00",
    lines: [{ account: "c1", taxes: ["p_iva_invsuj"] }], tags: ["wobi-auto-op1"], payments_total: "0", payments_pending: "20.00", payments_detail: [] as unknown[], draft: true };
  const movimiento = { id: "b1", banking_account_id: "a1", currency: "EUR", amount: "-20.00", reconciled_amount: "0.00", booking_date: r.fecha,
    status: "pending", description: "Proveedor", origin: "bank" };
  const contactos = [{ id: "p1", name: "Proveedor" }];
  const consultasGet: string[] = [];
  let attachment: { id: string; data: Buffer } | undefined;
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
      if (path.endsWith("/attachments")) {
        const file = (init.body as FormData).get("file") as File;
        attachment = { id: file.name, data: Buffer.from(await file.arrayBuffer()) };
        return json({});
      }
      throw new Error(`POST no esperado ${path}`);
    }
    consultasGet.push(path);
    if (path === "/contacts") return list(contactos);
    if (path === "/purchases") return list([]);
    if (path === "/taxes") return json({ items: [{ key: "p_iva_invsuj", name: "Inv. Suj. Pasivo",
      amount: null, scope: "purchases", type: "group", visible: true }] });
    if (path === "/expenses-accounts") return json({ items: [{ id: "c1", name: "Servicios", archived: false }] });
    if (path === "/treasury/accounts") return list([{ id: "a1", name: "Cuenta", currency: "EUR", archived: false }]);
    if (path === "/treasury/accounts/a1") return json({ id: "a1", currency: "EUR", archived: false });
    if (path.endsWith("/bank-movements")) return list([movimiento]);
    if (path === "/purchases/creada") return json(compra);
    if (path.endsWith("/attachments")) return list(attachment ? [attachment] : []);
    if (path.includes("/attachments/")) return new Response(attachment?.data);
    throw new Error(`GET no esperado ${path}`);
  };
  const adapter = new HoldedAuto(memoria, request);
  const d = evaluarAuto(c, analisisFixture(), r, evidenciaFixture(), configFixture); assert.ok(d.apto);
  const op: OperacionAuto = { id: "op1", plan: d.plan, estado: "creando" };
  return { adapter, request, memoria, compra, movimiento, contactos, consultasGet, posts, c, r, op,
    attachment: () => attachment };
}
test("consulta proveedor exacto, catálogo no paginado, memoria y cargo real", async () => {
  const e = escenario(); const ev = await e.adapter.evidencias(e.c, e.r);
  assert.equal(ev.consultasCompletas, true); assert.equal(ev.contacto?.id, "p1"); assert.equal(ev.cuenta?.id, "c1");
  assert.equal(ev.permiteTicket, true); assert.equal(ev.movimientos[0].origen, "bank");
});
test("conserva el equivalente contable que Holded entrega para una cuenta extranjera", async () => {
  const e = escenario();
  e.movimiento.currency = "USD";
  (e.movimiento as Record<string, unknown>).accounting_amount = "-17.35";
  (e.movimiento as Record<string, unknown>).accounting_currency = "EUR";
  const original = e.request;
  const request: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname.replace("/api/v2", "");
    if (!init?.method && path === "/treasury/accounts") {
      return new Response(JSON.stringify({ items: [{ id: "a1", name: "Cuenta", currency: "USD", archived: false }], has_more: false, cursor: null }));
    }
    return original(input, init);
  };
  const ev = await new HoldedAuto(e.memoria, request, ["WOBA"], undefined, undefined, async () => undefined).evidencias(e.c, e.r);
  assert.equal(ev.movimientos[0].contabilidadCentimos, -1735);
  assert.equal(ev.movimientos[0].monedaContable, "EUR");
});
test("reutiliza la política aprendida de Anthropic y toma el importe del cargo real", async () => {
  const e = escenario();
  e.r.proveedor = "Anthropic, PBC";
  e.r.moneda = "USD";
  e.r.monto = 24.2;
  e.contactos[0].name = "Anthropic, PBC";
  e.movimiento.currency = "EUR";
  e.movimiento.amount = "-21.32";
  e.movimiento.description = "ANTHROPIC";
  const flujo: FlujoGastoExistente = {
    clasificar: async () => ({ cuentaId: "c1", nombreCuenta: "Software", tags: ["software"], evidencia: "memoria" }),
    crear: async () => "", corregir: async () => undefined, adjuntar: async () => undefined,
    conciliar: async () => undefined, verificarConciliacion: async () => false,
  };
  const adapter = new HoldedAuto(e.memoria, e.request, ["WOBA"], flujo, undefined, async () => 0.880992);
  const evidencia = await adapter.evidencias(e.c, e.r);
  assert.deepEqual(evidencia.equivalenteBancario, {
    cuentaId: "a1", movimientoId: "b1", moneda: "EUR", montoCentimos: 2132,
    tasaReferencia: 0.880992, monedaOrigen: "USD",
  });
  const decision = evaluarAuto(e.c, analisisFixture(e.r), e.r, evidencia, configFixture);
  assert.equal(decision.apto, true, decision.apto ? undefined : decision.motivos.join(","));
  if (decision.apto) {
    assert.deepEqual(monedaRegistroPlanAuto(decision.plan), { moneda: "EUR", monto: 21.32 });
    assert.equal(decision.plan.totalCentimos, 2132);
    assert.equal(decision.plan.movimiento.id, "b1");
  }
});
test("una liquidación multimoneda ambigua permanece en revisión manual", async () => {
  const e = escenario();
  e.r.proveedor = "Anthropic, PBC";
  e.r.moneda = "USD";
  e.r.monto = 24.2;
  e.contactos[0].name = "Anthropic, PBC";
  const original = e.request;
  const request: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname.replace("/api/v2", "");
    if (!init?.method && path.endsWith("/bank-movements")) {
      const primero = { ...e.movimiento, currency: "EUR", amount: "-21.32", description: "ANTHROPIC" };
      return new Response(JSON.stringify({ items: [primero, { ...primero, id: "b2", amount: "-21.30" }], has_more: false, cursor: null }));
    }
    return original(input, init);
  };
  const evidencia = await new HoldedAuto(e.memoria, request, ["WOBA"], undefined, undefined, async () => 0.880992)
    .evidencias(e.c, e.r);
  assert.equal(evidencia.equivalenteBancario, undefined);
  const decision = evaluarAuto(e.c, analisisFixture(e.r), e.r, evidencia, configFixture);
  assert.equal(decision.apto, false);
  if (!decision.apto) assert.ok(decision.motivos.includes("sin_movimiento_exacto"));
});
test("un cambio de moneda genérico revisa todas las cuentas y admite la ventana aprendida solo con proveedor", async () => {
  const e = escenario();
  e.r.proveedor = "Scandic Holmenkollen Park";
  e.r.moneda = "NOK";
  e.r.monto = 1549;
  e.contactos[0].name = "Scandic Holmenkollen Park";
  e.movimiento.currency = "EUR";
  // El banco aplicó un importe 4,8% distinto a la referencia histórica.
  // Solo el descriptor inequívoco del proveedor permite conservarlo.
  e.movimiento.amount = "-126.00";
  e.movimiento.description = "SCANDIC HOLMENKOLLEN PARK";
  e.movimiento.booking_date = "2026-08-18";
  const original = e.request;
  const request: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname.replace("/api/v2", "");
    if (!init?.method && path === "/treasury/accounts") {
      return new Response(JSON.stringify({ items: [
        { id: "a1", name: "Cuenta EUR", currency: "EUR", archived: false },
        { id: "a2", name: "Cuenta NOK", currency: "NOK", archived: false },
      ], has_more: false, cursor: null }));
    }
    if (!init?.method && path === "/treasury/accounts/a2/bank-movements") {
      return new Response(JSON.stringify({ items: [], has_more: false, cursor: null }));
    }
    return original(input, init);
  };
  const adapter = new HoldedAuto(e.memoria, request, ["WOBA"], undefined, undefined, async () => 0.085467);
  const evidencia = await adapter.evidencias(e.c, e.r);
  assert.equal(evidencia.equivalenteBancario?.montoCentimos, 12600);
  e.movimiento.description = "COMERCIO DESCONOCIDO";
  const insegura = await new HoldedAuto(e.memoria, request, ["WOBA"], undefined, undefined, async () => 0.085467)
    .evidencias(e.c, e.r);
  assert.equal(insegura.equivalenteBancario, undefined);
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
test("verifica una compra extranjera por su importe nativo y la conversión demostrada", async () => {
  const e = escenario();
  e.op.plan.recibo.moneda = "USD";
  e.op.plan.recibo.monto = 151;
  e.op.plan.recibo.equivalente = { moneda: "EUR", monto: 130.81 };
  e.op.plan.movimiento.moneda = "EUR";
  e.op.plan.totalCentimos = 13081;
  e.op.compraId = await e.adapter.crear(e.op);
  const body = e.posts[0].body as Record<string, unknown>;
  assert.equal(body.currency, "USD");
  assert.equal(body.currency_change, 1.154346);
  assert.equal((body.items as Array<{ price: number }>)[0].price, 151);
  e.compra.currency = "USD";
  e.compra.total = "151.00";
  (e.compra as Record<string, unknown>).currency_change = "1.154346";
  assert.equal(await e.adapter.verificarCreacion(e.op), true);
  (e.compra as Record<string, unknown>).currency_change = "1.15";
  assert.equal(await e.adapter.verificarCreacion(e.op), true);
  (e.compra as Record<string, unknown>).currency_change = "1.14";
  assert.equal(await e.adapter.verificarCreacion(e.op), false);
  (e.compra as Record<string, unknown>).currency_change = "1.154346";
  e.compra.total = "130.81";
  assert.equal(await e.adapter.verificarCreacion(e.op), false);
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
  assert.notEqual(normalizarProveedorExacto("Nieuwe Veste (Restaurant, Breda)"), normalizarProveedorExacto("Nieuwe Veste"));
  assert.equal(normalizarProveedorExacto("Soluciones Alegra S.A.S"), normalizarProveedorExacto("SOLUCIONES ALEGRA S A S"));
  assert.notEqual(normalizarProveedorExacto("DHL"), normalizarProveedorExacto("DHL Express Spain SLU"));
});
test("una ficha de hotel con paréntesis no desplaza el alias Booking confirmado", async () => {
  const e = escenario();
  e.r.proveedor = "Booking.com";
  e.contactos[0].name = "Booking.com (Antaris Galerias / Hong Kong Road International Travel Limited)";
  e.contactos.push({ id: "booking-confirmado", name: "BOOKING HOLDINGS Inc." });
  e.memoria.alias = async () => [{ contactId: "booking-confirmado", contactName: "BOOKING HOLDINGS Inc." }];
  const evidencia = await e.adapter.evidencias(e.c, e.r);
  assert.equal(evidencia.contacto?.id, "booking-confirmado");
  assert.equal(evidencia.contacto?.metodo, "alias_confirmado");
});
test("acepta espaciado equivalente y el nombre exacto prevalece sobre un alias antiguo", async () => {
  const e = escenario();
  e.r.proveedor = "Copa Airlines";
  e.contactos[0].name = "CopaAirlines";
  e.memoria.alias = async () => [{ contactId: "contacto-antiguo", contactName: "Antiguo" }];
  const evidencia = await e.adapter.evidencias(e.c, e.r);
  assert.equal(evidencia.contacto?.id, "p1");
  assert.equal(evidencia.contacto?.metodo, "nombre_equivalente");
  assert.equal(evidencia.contacto?.exacto, true);
});
test("mayúsculas y un sufijo de local no impiden usar el contacto real equivalente", async () => {
  const e = escenario();
  e.r.proveedor = "Albert Heijn 1653 Schiphol";
  e.contactos[0].name = "ALBERT HEIJN";
  e.movimiento.description = "ALBERT HEIJN SCHIPHOL";
  const evidencia = await e.adapter.evidencias(e.c, e.r);
  assert.equal(evidencia.contacto?.id, "p1");
  assert.equal(evidencia.contacto?.metodo, "nombre_equivalente");
  assert.equal(evidencia.contacto?.exacto, true);
  const decision = evaluarAuto(e.c, analisisFixture(e.r), e.r, evidencia, configFixture);
  assert.equal(decision.apto, true, decision.apto ? undefined : decision.motivos.join(","));
});
test("una confianza baja no se disfraza como proveedor ausente", async () => {
  const e = escenario(); e.r.confianza = "baja";
  const evidencia = await e.adapter.evidencias(e.c, e.r);
  assert.equal(evidencia.contacto?.id, "p1");
  const decision = evaluarAuto(e.c, analisisFixture(e.r), e.r, evidencia, configFixture);
  assert.equal(decision.apto, false);
  if (!decision.apto) {
    assert.ok(decision.motivos.includes("confianza_insuficiente"));
    assert.equal(decision.motivos.includes("proveedor_no_encontrado"), false);
  }
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
  assert.equal(evidencia.motivoProveedor, "coincidencia_ambigua");
  assert.equal(e.consultasGet.includes("/expenses-accounts"), false);
});
test("reutiliza catálogos y la misma ventana bancaria durante una pasada", async () => {
  const e = escenario();
  await e.adapter.evidencias(e.c, e.r);
  await e.adapter.evidencias(e.c, e.r);
  const veces = (path: string) => e.consultasGet.filter(p => p === path).length;
  assert.equal(veces("/contacts"), 1);
  assert.equal(veces("/treasury/accounts"), 1);
  assert.equal(veces("/expenses-accounts"), 1);
  assert.equal(veces("/purchases"), 4);
  assert.equal(veces("/treasury/accounts/a1/bank-movements"), 1);
});
test("el cuerpo del correo se convierte en PDF y se verifica por su contenido final", async () => {
  const e = escenario(); e.op.compraId = "creada";
  await e.adapter.adjuntar(e.op, e.c);
  assert.equal(e.op.plan.soporteMime, "application/pdf");
  assert.match(e.op.plan.soporteNombre ?? "", /\.pdf$/);
  assert.equal(e.attachment()?.data.subarray(0, 4).toString("ascii"), "%PDF");
  assert.equal(await e.adapter.verificarAdjunto(e.op), true);
  e.op.plan.soporteHash = hash("otro archivo");
  assert.equal(await e.adapter.verificarAdjunto(e.op), false);
  await assert.rejects(() => e.adapter.adjuntar(e.op, e.c), /archivo contable preparado/);
});
test("el comprobante visual recibe el HTML original y nunca lo carga como texto", async () => {
  const e = escenario(); e.op.compraId = "creada";
  e.c.htmlOriginal = "<html><body><strong>Recibo visual</strong></body></html>";
  let renderizado = 0;
  const adapter = new HoldedAuto(e.memoria, e.request, ["WOBA"], undefined, async correo => {
    renderizado++;
    assert.equal(correo.htmlOriginal, e.c.htmlOriginal);
    assert.match(correo.cuerpoCompleto, /Recibo real/);
    return Buffer.from("%PDF-1.4\nrecibo visual");
  });
  await adapter.prepararAdjunto(e.op, e.c);
  await adapter.adjuntar(e.op, e.c);
  assert.equal(renderizado, 1);
  assert.equal(e.op.plan.soporteMime, "application/pdf");
  assert.equal(e.attachment()?.data.toString(), "%PDF-1.4\nrecibo visual");
});
test("filas repetidas del mismo soporte se descargan una vez y no provocan otra carga", async () => {
  const e = escenario(); e.op.compraId = "creada";
  await e.adapter.adjuntar(e.op, e.c);
  const original = e.request;
  let descargas = 0;
  const prefijo = `wobi-${e.op.id}-${e.op.plan.fuenteHash.slice(0, 16)}`;
  const request: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname.replace("/api/v2", "");
    if (!init?.method && path.endsWith("/attachments")) {
      return new Response(JSON.stringify({ items: [{ id: `${prefijo}-1` }, { id: `${prefijo}-1` }], has_more: false, cursor: null }), { status: 200 });
    }
    if (!init?.method && path.includes(`/attachments/${prefijo}-`)) {
      descargas++;
      return new Response(e.attachment()?.data);
    }
    return original(input, init);
  };
  const adapter = new HoldedAuto(e.memoria, request);
  assert.equal(await adapter.verificarAdjunto(e.op), true);
  assert.equal(descargas, 1);
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
test("el nombre exacto prevalece sobre alias contradictorios y las respuestas paginadas incompletas fallan", async () => {
  const e = escenario(); e.memoria.alias = async () => [{ contactId: "p1", contactName: "Proveedor" }, { contactId: "p2", contactName: "Otro" }];
  const evidencia = await e.adapter.evidencias(e.c, e.r);
  assert.equal(evidencia.contacto?.id, "p1");
  assert.equal(evidencia.contacto?.metodo, "nombre_exacto");
  const broken = new HoldedAuto(e.memoria, async () => new Response(JSON.stringify({ items: [] })));
  await assert.rejects(() => broken.listar("WOBA", "/contacts"), /Paginación/);
});
test("alias contradictorios sin coincidencia por nombre no autorizan", async () => {
  const e = escenario();
  e.r.proveedor = "ZZQVV proveedor ausente";
  e.memoria.alias = async () => [{ contactId: "p1", contactName: "Proveedor" }, { contactId: "p2", contactName: "Otro" }];
  const evidencia = await e.adapter.evidencias(e.c, e.r);
  assert.equal(evidencia.contacto, undefined);
  assert.equal(evidencia.motivoProveedor, "alias_contradictorio");
});
test("un alias único no se presenta como proveedor exacto ni autoriza un contacto sin relación", async () => {
  const e = escenario();
  e.r.proveedor = "Parking Moraleja";
  e.contactos[0].name = "CADENA COMERCIAL OXXO SA";
  e.memoria.alias = async () => [{ contactId: "p1", contactName: "CADENA COMERCIAL OXXO SA" }];
  const evidencia = await e.adapter.evidencias(e.c, e.r);
  assert.equal(evidencia.contacto?.metodo, "alias_confirmado");
  assert.equal(evidencia.contacto?.exacto, false);
  const decision = evaluarAuto(e.c, analisisFixture(e.r), e.r, evidencia, configFixture);
  assert.equal(decision.apto, false);
  if (!decision.apto) assert.ok(decision.motivos.includes("proveedor_no_verificado"));
});
test("un HTTP ambiguo no provoca reintento automático de POST", async () => {
  const e = escenario(); let intentos = 0;
  const broken = new HoldedAuto(e.memoria, async () => { intentos++; return new Response("", { status: 503 }); });
  await assert.rejects(() => broken.crear(e.op), /no se repetirá/);
  assert.equal(intentos, 1);
});

test("la automatización delega cuenta y creación al flujo aprendido uno a uno", async () => {
  const e = escenario();
  const llamadas: string[] = [];
  const flujo: FlujoGastoExistente = {
    clasificar: async () => {
      llamadas.push("clasificar");
      return { cuentaId: "cuenta-aprendida", nombreCuenta: "Travel Expenses",
        tags: ["transporte", "avion"], evidencia: "precedentes confirmados" };
    },
    crear: async () => { llamadas.push("crear"); return "compra-aprendida"; },
    corregir: async () => { llamadas.push("corregir"); },
    adjuntar: async () => { llamadas.push("adjuntar"); },
    conciliar: async () => { llamadas.push("conciliar"); },
    verificarConciliacion: async () => true,
  };
  const adapter = new HoldedAuto(e.memoria, e.request, ["WOBA"], flujo);
  const evidencia = await adapter.evidencias(e.c, e.r);
  assert.deepEqual(evidencia.cuenta, { id: "cuenta-aprendida", nombre: "Travel Expenses",
    tags: ["transporte", "avion"], evidencia: "precedentes confirmados" });
  assert.equal(e.consultasGet.includes("/expenses-accounts"), false);
  assert.equal(await adapter.crear(e.op), "compra-aprendida");
  assert.deepEqual(llamadas, ["clasificar", "crear"]);
});

test("recupera y corrige un borrador legado por la nota privada, no por tags visibles", async () => {
  const e = escenario();
  e.op.compraId = "legada";
  const corregidas: string[] = [];
  const flujo: FlujoGastoExistente = {
    clasificar: async () => ({ cuentaId: "c1", nombreCuenta: "Travel Expenses", tags: ["alimentacion"], evidencia: "memoria" }),
    crear: async () => { throw new Error("no debe crear otra compra"); },
    corregir: async (_op, id) => { corregidas.push(id); },
    adjuntar: async () => undefined,
    conciliar: async () => undefined,
    verificarConciliacion: async () => false,
  };
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
  const request: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname.replace("/api/v2", "");
    if (!init?.method && path === "/purchases") return json({ items: [{ id: "legada" }], has_more: false, cursor: null });
    if (!init?.method && path === "/purchases/legada") return json({ id: "legada", notes: "WOBI_AUTO:op1" });
    return e.request(input, init);
  };
  const adapter = new HoldedAuto(e.memoria, request, ["WOBA"], flujo);
  assert.equal(await adapter.recuperarCreacion(e.op), "legada");
  assert.deepEqual(corregidas, ["legada"]);
});

test("recupera por el compraId durable una operación antigua creada antes de guardar la nota privada", async () => {
  const e = escenario();
  e.op.compraId = "legada-sin-nota";
  e.op.plan.version = "correo-gastos-v13";
  const corregidas: string[] = [];
  const flujo: FlujoGastoExistente = {
    clasificar: async () => ({ cuentaId: "c1", nombreCuenta: "Travel Expenses", tags: ["alimentacion"], evidencia: "memoria" }),
    crear: async () => { throw new Error("no debe crear otra compra"); },
    corregir: async (_op, id) => { corregidas.push(id); },
    adjuntar: async () => undefined,
    conciliar: async () => undefined,
    verificarConciliacion: async () => false,
  };
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
  const request: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname.replace("/api/v2", "");
    if (!init?.method && path === "/purchases/legada-sin-nota") return json({ id: "legada-sin-nota" });
    return e.request(input, init);
  };
  const adapter = new HoldedAuto(e.memoria, request, ["WOBA"], flujo);
  assert.equal(await adapter.recuperarCreacion(e.op), "legada-sin-nota");
  assert.deepEqual(corregidas, ["legada-sin-nota"]);
});

test("la verificación aprendida exige cuenta y tags funcionales exactos", async () => {
  const e = escenario();
  const flujo: FlujoGastoExistente = {
    clasificar: async () => undefined,
    crear: async () => "creada",
    corregir: async () => undefined,
    adjuntar: async () => undefined,
    conciliar: async () => undefined,
    verificarConciliacion: async () => false,
  };
  const adapter = new HoldedAuto(e.memoria, e.request, ["WOBA"], flujo);
  e.op.compraId = "creada";
  e.op.plan.evidencia.cuenta = { id: "c1", evidencia: "memoria", tags: ["Núria Ortiz", "avion"] };
  e.compra.tags = ["nuriaortiz", "avion"];
  assert.equal(await adapter.verificarCreacion(e.op), true);
  e.op.plan.recibo.numero = undefined;
  e.compra.document_number = "NUMERO-YA-VERIFICADO";
  assert.equal(await adapter.verificarCreacion(e.op), true);
  e.compra.document_number = "";
  assert.equal(await adapter.verificarCreacion(e.op), false);
  e.compra.document_number = "NUMERO-YA-VERIFICADO";
  e.op.plan.evidencia.cuenta.tags = ["nicolasgomez"];
  e.compra.tags = ["nicolasgomez", "transporte", "avion"];
  assert.equal(await adapter.verificarCreacion(e.op), true);
  e.compra.tags = ["nicolasgomez"];
  assert.equal(await adapter.verificarCreacion(e.op), true);
  e.op.plan.evidencia.cuenta.tags = ["Simon Talloen"];
  e.compra.tags = ["simontalloen"];
  assert.equal(await adapter.verificarCreacion(e.op), true);
  e.compra.tags = [];
  assert.equal(await adapter.verificarCreacion(e.op), false);
  e.compra.tags = ["otrapersona"];
  assert.equal(await adapter.verificarCreacion(e.op), false);
  e.compra.tags = ["simontalloen", "wobiautoop1"];
  assert.equal(await adapter.verificarCreacion(e.op), false);
  e.op.plan.evidencia.cuenta.tags = ["Núria Ortiz", "avion"];
  e.compra.tags = ["nuriaortiz", "wobiautoop1"];
  assert.equal(await adapter.verificarCreacion(e.op), false);
  e.compra.tags = ["nuriaortiz", "avion"];
  e.compra.lines = [{ account: "otra-cuenta", taxes: ["p_iva_invsuj"] }];
  assert.equal(await adapter.verificarCreacion(e.op), false);
  e.compra.lines = [{ account: "c1", taxes: [] }];
  assert.equal(await adapter.verificarCreacion(e.op), false);
});
test("busca cargo multimoneda aunque el contacto siga ambiguo, sin autorizar crear", async () => {
  const e = escenario(); e.r.moneda = "MXN"; e.r.monto = 400;
  e.contactos.push({id:"p2",name:"Proveedor"});
  const adapter = new HoldedAuto(e.memoria,e.request,["WOBA"],undefined,undefined,async () => 0.05);
  const ev = await adapter.evidencias(e.c,e.r);
  assert.equal(ev.contacto,undefined);
  assert.equal(ev.equivalenteBancario?.movimientoId,"b1");
  const decision = evaluarAuto(e.c,analisisFixture(e.r),e.r,ev,configFixture);
  assert.equal(decision.apto,false);
  if(!decision.apto){assert.ok(decision.motivos.includes("proveedor_no_encontrado"));assert.ok(!decision.motivos.includes("sin_movimiento_exacto"));}
  assert.equal(e.posts.length,0);
});
test("alias confirmado desambigua fichas del mismo proveedor sin bloquear por SA o acentos", async () => {
  const e=escenario(); e.r.proveedor="Inter Rapidísimo";
  e.contactos[0].name="INTER RAPIDISIMO S.A";
  e.contactos.push({id:"p2",name:"INTER RAPIDISIMO S.A"});
  e.memoria.alias=async()=>[{contactId:"p2",contactName:"INTER RAPIDISIMO S.A"}];
  const ev=await e.adapter.evidencias(e.c,e.r);
  assert.equal(ev.contacto?.id,"p2");
  assert.equal(ev.contacto?.metodo,"alias_confirmado");
  assert.equal(ev.contacto?.exacto,true);
  assert.equal(evaluarAuto(e.c,analisisFixture(e.r),e.r,ev,configFixture).apto,true);
});

test("Uber selects receipt country over an old alias; missing geography uses generic Uber", async () => {
  for (const [concepto, id] of [["Trayecto Bogotá, Colombia", "co"], ["Trayecto 4 km en EUR", "generic"]]) {
    const e = escenario(); e.r.proveedor = "Uber"; e.r.concepto = concepto;
    e.contactos.splice(0, e.contactos.length,
      {id:"co",name:"UBER COLOMBIA"}, {id:"es",name:"UBER SYSTEMS SPAIN SL."}, {id:"generic",name:"Uber"});
    e.memoria.alias = async () => [{contactId:"es",contactName:"UBER SYSTEMS SPAIN SL."}];
    const ev = await e.adapter.evidencias(e.c, e.r);
    assert.equal(ev.contacto?.id, id); assert.equal(ev.contacto?.exacto, true);
    assert.equal(ev.motivoProveedor, undefined);
  }
});

test("Uber Eats reuses an authorized existing duplicate without POST contact", async () => {
  const e = escenario(); e.r.proveedor = "Uber Eats";
  e.contactos.splice(0,e.contactos.length,{id:"z",name:"Uber eats"},{id:"a",name:"UBER EATS"});
  const ev = await e.adapter.evidencias(e.c,e.r);
  assert.equal(ev.contacto?.id,"a"); assert.equal(ev.contacto?.exacto,true); assert.equal(e.posts.length,0);
});

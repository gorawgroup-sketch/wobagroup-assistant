import assert from "node:assert/strict";
import test from "node:test";
import cron from "node-cron";
import { fechaHoyEspana } from "../../utils/diaHabil";
import type { TreasuryAccount } from "../client";
import { clasificarDocumento } from "./clasificacionTicket";
import { empresasAutomatizacion, modoAutomatizacion } from "./modo";
import type { CuentaParaNavegador, NavegadorHolded, ResultadoNavegador } from "./navegador";
import {
  clasificarCuenta, cuentaTieneActualizacionConfirmada, lanzarSincronizacionBancaria, textoAvisoSincronizacion,
  verificarSincronizacionBancaria, VENTANA_VERIFICACION_MS,
} from "./sincronizacionBancaria";
import { claveTicket, diferenciasInstantanea, instantaneaCompra, inventarioCandidatos, procesarColaTickets, registrarClasificacionDocumento } from "./tickets";
import { AlmacenTrabajosMemoria } from "./trabajos";

function conEntorno<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previo: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { previo[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  return fn().finally(() => { for (const k of Object.keys(previo)) { if (previo[k] === undefined) delete process.env[k]; else process.env[k] = previo[k]; } });
}

/* ───────── modo / kill-switch ───────── */
test("sin variable, ambas automatizaciones están apagadas; un valor desconocido tampoco activa nada", () => {
  assert.equal(modoAutomatizacion("TICKETS", {}), "apagado");
  assert.equal(modoAutomatizacion("SYNC_BANCARIA", { WOBI_HOLDED_SYNC_BANCARIA_MODO: "quizas" }), "apagado");
  assert.equal(modoAutomatizacion("SYNC_BANCARIA", { WOBI_HOLDED_SYNC_BANCARIA_MODO: "activo" }), "activo");
});
test("en modo activo el alcance es explícito: sin lista no se toca ninguna empresa", () => {
  assert.deepEqual(empresasAutomatizacion("TICKETS", { WOBI_HOLDED_TICKETS_MODO: "activo" }), []);
  assert.deepEqual(empresasAutomatizacion("TICKETS", { WOBI_HOLDED_TICKETS_MODO: "activo", WOBI_HOLDED_TICKETS_EMPRESAS: "footprint" }), ["Footprint"]);
  assert.deepEqual(empresasAutomatizacion("TICKETS", { WOBI_HOLDED_TICKETS_MODO: "apagado", WOBI_HOLDED_TICKETS_EMPRESAS: "WOBA" }), []);
});

/* ───────── horario / cambio de hora ───────── */
test("06:00 Madrid: la fecha de la clave es la de Madrid en verano e invierno, y el cron es válido", () => {
  assert.equal(fechaHoyEspana(new Date("2026-07-01T04:00:00Z")), "2026-07-01"); // 06:00 CEST
  assert.equal(fechaHoyEspana(new Date("2026-01-15T05:00:00Z")), "2026-01-15"); // 06:00 CET
  assert.equal(fechaHoyEspana(new Date("2026-03-29T04:00:00Z")), "2026-03-29"); // día del cambio a verano
  assert.equal(fechaHoyEspana(new Date("2026-10-25T05:00:00Z")), "2026-10-25"); // día del cambio a invierno
  for (const expr of ["0 6 * * *", "10,30,50 6-9 * * *", "45 9 * * *", "5,35 * * * *", "30 2 * * *"]) assert.ok(cron.validate(expr), expr);
});

/* ───────── sincronización bancaria ───────── */
const cuenta = (id: string, extra: Partial<TreasuryAccount> = {}): TreasuryAccount => ({
  id, name: `Cuenta ${id}`, type: "bank", currency: "EUR", institution_id: "revolut_business_es", institution_name: "Revolut", archived: false,
  synced_at: "2026-10-01T10:00:00+00:00", transactions_pending_to_reconcile: 2, ...extra });

test("clasifica: conectada vs manual, efectivo y archivada", () => {
  assert.equal(clasificarCuenta("WOBA", cuenta("a")).sincronizable, true);
  assert.equal(clasificarCuenta("WOBA", cuenta("b", { archived: true })).motivo, "archivada");
  assert.equal(clasificarCuenta("WOBA", cuenta("c", { type: "gateway", institution_id: null, institution_name: undefined, synced_at: null })).sincronizable, false);
  assert.equal(clasificarCuenta("WOBA", cuenta("d", { type: "cash", institution_id: null, institution_name: undefined })).motivo, "efectivo");
  assert.equal(clasificarCuenta("WOBA", cuenta("e")).clave, "WOBA:e");
});

class NavegadorFalso implements NavegadorHolded {
  llamadas: string[] = [];
  constructor(private respuesta: (c: CuentaParaNavegador) => ResultadoNavegador = () => ({ estado: "ok" })) {}
  async sincronizarCuenta(_e: string, c: CuentaParaNavegador) { this.llamadas.push(c.id); return this.respuesta(c); }
  async desmarcarFacturaDeCompra(): Promise<ResultadoNavegador> { throw new Error("no aplica"); }
  async cerrar() {}
}
const ENV_SYNC = { WOBI_HOLDED_SYNC_BANCARIA_MODO: "activo", WOBI_HOLDED_SYNC_BANCARIA_EMPRESAS: "WOBA" };

test("modo activo: lanza, NO declara completada hasta ver synced_at posterior; luego completada con hora de verificación", () =>
  conEntorno(ENV_SYNC, async () => {
    let t = Date.parse("2026-10-02T04:00:00Z");
    let sync = "2026-10-01T10:00:00+00:00";
    const almacen = new AlmacenTrabajosMemoria();
    const nav = new NavegadorFalso();
    const dep = { almacen, navegador: () => nav, leerCuentas: async () => [cuenta("a", { synced_at: sync }), cuenta("manual", { institution_id: null, institution_name: undefined })], ahora: () => t, dormir: async () => {} };
    const r = await lanzarSincronizacionBancaria("2026-10-02", dep);
    assert.deepEqual(nav.llamadas, ["a"]); // la manual no se toca
    assert.equal(r.cuentas, 1);
    assert.equal((await almacen.obtener("sync:2026-10-02:WOBA:a"))?.estado, "en_curso"); // botón pulsado ≠ completada
    t += 5 * 60_000;
    assert.deepEqual(await verificarSincronizacionBancaria(dep), { verificadas: 1, completadas: 0, noConfirmadas: 0 }); // sin evidencia aún
    assert.equal((await almacen.obtener("sync:2026-10-02:WOBA:a"))?.estado, "en_curso");
    sync = "2026-10-02T04:03:00+00:00";
    await verificarSincronizacionBancaria(dep);
    const fin = await almacen.obtener("sync:2026-10-02:WOBA:a");
    assert.equal(fin?.estado, "completado");
    assert.ok(fin?.verificadoEn);
    assert.equal((await cuentaTieneActualizacionConfirmada(almacen, "WOBA", "a", Date.parse("2026-10-02T00:00:00Z"))).confirmada, true);
  }));

test("sincronización lanzada pero sin evidencia dentro de la ventana → «no confirmado», nunca completada", () =>
  conEntorno(ENV_SYNC, async () => {
    let t = Date.parse("2026-10-02T04:00:00Z");
    const almacen = new AlmacenTrabajosMemoria();
    const dep = { almacen, navegador: () => new NavegadorFalso(), leerCuentas: async () => [cuenta("a")], ahora: () => t, dormir: async () => {} };
    await lanzarSincronizacionBancaria("2026-10-02", dep);
    t += VENTANA_VERIFICACION_MS + 60_000;
    const r = await verificarSincronizacionBancaria(dep);
    assert.equal(r.noConfirmadas, 1);
    const trabajo = await almacen.obtener("sync:2026-10-02:WOBA:a");
    assert.equal(trabajo?.estado, "no_confirmado");
    assert.match(textoAvisoSincronizacion([trabajo!]) ?? "", /sin actualización confirmada/);
    assert.equal((await cuentaTieneActualizacionConfirmada(almacen, "WOBA", "a", 0)).confirmada, false);
  }));

test("sesión caducada o banco que exige consentimiento: requiere intervención, sin reintentos ni reconexión", () =>
  conEntorno(ENV_SYNC, async () => {
    const almacen = new AlmacenTrabajosMemoria();
    const nav = new NavegadorFalso(() => ({ estado: "sesion_caducada", detalle: "caducó" }));
    await lanzarSincronizacionBancaria("2026-10-02", { almacen, navegador: () => nav, leerCuentas: async () => [cuenta("a")], dormir: async () => {} });
    assert.equal(nav.llamadas.length, 1);
    assert.equal((await almacen.obtener("sync:2026-10-02:WOBA:a"))?.estado, "requiere_intervencion");
  }));

test("sin sesión web configurada: requiere intervención (no se inventa nada)", () =>
  conEntorno(ENV_SYNC, async () => {
    const almacen = new AlmacenTrabajosMemoria();
    await lanzarSincronizacionBancaria("2026-10-02", { almacen, navegador: () => undefined, leerCuentas: async () => [cuenta("a")] });
    assert.equal((await almacen.obtener("sync:2026-10-02:WOBA:a"))?.estado, "requiere_intervencion");
  }));

test("una cuenta que falla no bloquea a las demás; los errores transitorios se reintentan con límite", () =>
  conEntorno(ENV_SYNC, async () => {
    const almacen = new AlmacenTrabajosMemoria();
    const nav = new NavegadorFalso((c) => (c.id === "mala" ? { estado: "error", detalle: "boom" } : { estado: "ok" }));
    await lanzarSincronizacionBancaria("2026-10-02", { almacen, navegador: () => nav, leerCuentas: async () => [cuenta("mala"), cuenta("buena")], dormir: async () => {}, esperaMs: () => 0 });
    assert.equal(nav.llamadas.filter((x) => x === "mala").length, 3);
    assert.equal((await almacen.obtener("sync:2026-10-02:WOBA:mala"))?.estado, "fallido");
    assert.equal((await almacen.obtener("sync:2026-10-02:WOBA:buena"))?.estado, "en_curso");
  }));

test("antes de reintentar se mira el estado real: si Holded ya actualizó, no se repite la acción", () =>
  conEntorno(ENV_SYNC, async () => {
    const almacen = new AlmacenTrabajosMemoria();
    let lecturas = 0;
    const nav = new NavegadorFalso(() => ({ estado: "error", detalle: "timeout tras pulsar" }));
    await lanzarSincronizacionBancaria("2026-10-02", { almacen, navegador: () => nav, ahora: () => Date.parse("2026-10-02T04:00:00Z"), dormir: async () => {}, esperaMs: () => 0,
      leerCuentas: async () => [cuenta("a", { synced_at: ++lecturas > 1 ? "2026-10-02T04:01:00+00:00" : "2026-10-01T10:00:00+00:00" })] });
    assert.equal(nav.llamadas.length, 1);
    assert.equal((await almacen.obtener("sync:2026-10-02:WOBA:a"))?.estado, "en_curso");
  }));

test("reinicio / doble disparo: la segunda ejecución del día no vuelve a lanzar lo ya lanzado", () =>
  conEntorno(ENV_SYNC, async () => {
    const almacen = new AlmacenTrabajosMemoria();
    const nav = new NavegadorFalso();
    const dep = { almacen, navegador: () => nav, leerCuentas: async () => [cuenta("a")], dormir: async () => {} };
    await lanzarSincronizacionBancaria("2026-10-02", dep);
    await Promise.all([lanzarSincronizacionBancaria("2026-10-02", dep), lanzarSincronizacionBancaria("2026-10-02", dep)]);
    assert.equal(nav.llamadas.length, 1);
  }));

test("simulación: no abre el navegador ni escribe; solo registra lo que haría", () =>
  conEntorno({ WOBI_HOLDED_SYNC_BANCARIA_MODO: "simulacion" }, async () => {
    const almacen = new AlmacenTrabajosMemoria();
    const nav = new NavegadorFalso();
    const r = await lanzarSincronizacionBancaria("2026-10-02", { almacen, navegador: () => nav, leerCuentas: async () => [cuenta("a")] });
    assert.equal(nav.llamadas.length, 0);
    assert.equal(r.porEstado.simulado, 3); // una por empresa (el lector falso devuelve la misma cuenta)
  }));

test("apagado: no lee ni toca nada", () =>
  conEntorno({ WOBI_HOLDED_SYNC_BANCARIA_MODO: undefined }, async () => {
    let leido = false;
    const r = await lanzarSincronizacionBancaria("2026-10-02", { almacen: new AlmacenTrabajosMemoria(), leerCuentas: async () => { leido = true; return []; } });
    assert.equal(leido, false);
    assert.equal(r.cuentas, 0);
  }));

test("un fallo de Holded al leer cuentas no se toma por «no hay cuentas» y no frena a otras empresas", () =>
  conEntorno({ WOBI_HOLDED_SYNC_BANCARIA_MODO: "activo", WOBI_HOLDED_SYNC_BANCARIA_EMPRESAS: "WOBA,EWORKS" }, async () => {
    const almacen = new AlmacenTrabajosMemoria();
    const nav = new NavegadorFalso();
    const r = await lanzarSincronizacionBancaria("2026-10-02", { almacen, navegador: () => nav, dormir: async () => {},
      leerCuentas: async (e) => { if (e === "WOBA") throw new Error("503"); return [cuenta("x")]; } });
    assert.equal(r.porEstado.fallido, 1);
    assert.equal((await almacen.obtener("sync:2026-10-02:EWORKS:x"))?.estado, "en_curso");
  }));

/* ───────── clasificación ticket/factura ───────── */
test("ticket auténtico: se declara ticket/simplificado y no identifica al comprador", () => {
  const r = clasificarDocumento({ proveedor: "Nori Nori", textoEvidencia: "Factura Simplificada nº 123", reciboSimplificado: true, numeroDocumento: "123" });
  assert.equal(r.tipo, "ticket");
});
test("factura auténtica: identifica al comprador o se declara factura con número", () => {
  assert.equal(clasificarDocumento({ proveedor: "DHL", identificaComprador: true, numeroDocumento: "F-1" }).tipo, "factura");
  assert.equal(clasificarDocumento({ proveedor: "Hotel", textoEvidencia: "Invoice number 8891", numeroDocumento: "8891" }).tipo, "factura");
});
test("dudoso: falta el número o el extractor marcó simplificado «por duda» → revisar, nunca ticket", () => {
  assert.equal(clasificarDocumento({ proveedor: "Uber", textoEvidencia: "Viaje 12/09" }).tipo, "revisar");
  assert.equal(clasificarDocumento({ proveedor: "Uber", reciboSimplificado: true, textoEvidencia: "Viaje" }).tipo, "revisar");
  assert.equal(clasificarDocumento({ proveedor: "X", textoEvidencia: "ticket, Factura nº 12", reciboSimplificado: true }).tipo, "revisar"); // contradictorio
});

/* ───────── conversión a ticket ───────── */
const compra = (extra: Record<string, unknown> = {}) => ({ id: "c1", contact_id: "k1", date: "2026-09-20", currency: "USD", currency_change: "1.0905", subtotal: "10,00", total: "10,00", tax: "0,00",
  document_number: "A-1", status: "paid", tags: ["b", "a"], payments_total: "10,00", payments_pending: "0,00", payments_detail: [{ id: "p1", amount: "10,00" }],
  lines: [{ name: "Viaje", price: "10,00", units: "1,00", discount: "0,00", tax: "0", taxes: [], account: "acc1", retention: "0,00", tags: [] }], deduction_date: null, accounting_date: null, ...extra });

class MundoHolded {
  listado = new Set<string>(["c1"]);
  compras = new Map<string, Record<string, unknown>>([["c1", compra()]]);
  fallaLectura = false;
  leer = async (_e: string, ruta: string) => {
    if (this.fallaLectura) throw Object.assign(new Error("503"), { status: 503 });
    if (ruta === "/purchases") return { items: [...this.listado].map((id) => ({ id })), has_more: false };
    const id = ruta.split("/").pop()!;
    const c = this.compras.get(id);
    if (!c) throw Object.assign(new Error("404"), { status: 404 });
    return c;
  };
}
const navegadorTickets = (mundo: MundoHolded, accion: (mundo: MundoHolded) => ResultadoNavegador): NavegadorHolded => ({
  sincronizarCuenta: async () => ({ estado: "ok" }), cerrar: async () => {},
  desmarcarFacturaDeCompra: async () => accion(mundo),
});
const ENV_TICKETS = { WOBI_HOLDED_TICKETS_MODO: "activo", WOBI_HOLDED_TICKETS_EMPRESAS: "Footprint" };
async function preparar(estadoInicial: "solicitado" = "solicitado") {
  const almacen = new AlmacenTrabajosMemoria();
  const t = await registrarClasificacionDocumento(almacen, { empresa: "Footprint", compraId: "c1", proveedor: "Nori", textoEvidencia: "Factura Simplificada", reciboSimplificado: true, numeroDocumento: "9" });
  assert.equal(t?.estado, estadoInicial);
  return almacen;
}

test("registro al recibir: ticket → cola; factura → omitido; dudoso → revisión, con evidencia; idempotente", () =>
  conEntorno(ENV_TICKETS, async () => {
    const almacen = new AlmacenTrabajosMemoria();
    const base = { empresa: "Footprint" as const, proveedor: "P" };
    assert.equal((await registrarClasificacionDocumento(almacen, { ...base, compraId: "t", textoEvidencia: "ticket" }))?.estado, "solicitado");
    assert.equal((await registrarClasificacionDocumento(almacen, { ...base, compraId: "f", identificaComprador: true }))?.estado, "omitido");
    const d = await registrarClasificacionDocumento(almacen, { ...base, compraId: "d" });
    assert.equal(d?.estado, "requiere_intervencion");
    assert.ok((d?.evidencia.motivos as string[]).length > 0);
    assert.equal(await registrarClasificacionDocumento(almacen, { ...base, compraId: "t", textoEvidencia: "ticket" }), undefined);
  }));

test("conversión correcta: gasto CONCILIADO conserva todo (cobros, tasa, cuentas, etiquetas) y queda ticket", () =>
  conEntorno(ENV_TICKETS, async () => {
    const almacen = await preparar(); const mundo = new MundoHolded();
    const r = await procesarColaTickets({ almacen, leer: mundo.leer, navegador: () => navegadorTickets(mundo, (m) => { m.listado.delete("c1"); return { estado: "ok" }; }) });
    assert.equal(r.porEstado.completado, 1);
    const t = await almacen.obtener(claveTicket("Footprint", "c1"));
    assert.equal(t?.estado, "completado");
    assert.ok(t?.verificadoEn);
  }));

test("si cambia cualquier otro campo (p. ej. tasa o cobro) el caso se detiene y se informa", () =>
  conEntorno(ENV_TICKETS, async () => {
    const almacen = await preparar(); const mundo = new MundoHolded();
    const r = await procesarColaTickets({ almacen, leer: mundo.leer, navegador: () => navegadorTickets(mundo, (m) => { m.listado.delete("c1"); m.compras.set("c1", compra({ currency_change: "1.0000", payments_total: "0,00" })); return { estado: "ok" }; }) });
    assert.equal(r.porEstado.requiere_intervencion, 1);
    const t = await almacen.obtener(claveTicket("Footprint", "c1"));
    assert.deepEqual(t?.evidencia.camposCambiados, ["cambio", "cobrado"]);
  }));

test("fallo/interrupción tras guardar: el navegador falla pero Holded ya lo tiene como ticket → completado, sin repetir", () =>
  conEntorno(ENV_TICKETS, async () => {
    const almacen = await preparar(); const mundo = new MundoHolded();
    await procesarColaTickets({ almacen, leer: mundo.leer, navegador: () => navegadorTickets(mundo, (m) => { m.listado.delete("c1"); return { estado: "error", detalle: "timeout al cerrar" }; }) });
    assert.equal((await almacen.obtener(claveTicket("Footprint", "c1")))?.estado, "completado");
  }));

test("guardado «ok» pero Holded sigue mostrándolo como factura → no confirmado (no se declara hecho)", () =>
  conEntorno(ENV_TICKETS, async () => {
    const almacen = await preparar(); const mundo = new MundoHolded();
    await procesarColaTickets({ almacen, leer: mundo.leer, navegador: () => navegadorTickets(mundo, () => ({ estado: "ok" })) });
    assert.equal((await almacen.obtener(claveTicket("Footprint", "c1")))?.estado, "no_confirmado");
  }));

test("gasto que ya era ticket: se omite sin tocar el navegador", () =>
  conEntorno(ENV_TICKETS, async () => {
    const almacen = await preparar(); const mundo = new MundoHolded(); mundo.listado.clear();
    let abierto = false;
    await procesarColaTickets({ almacen, leer: mundo.leer, navegador: () => { abierto = true; return undefined; } });
    assert.equal(abierto, false);
    const t = await almacen.obtener(claveTicket("Footprint", "c1"));
    assert.equal(t?.estado, "omitido"); assert.equal(t?.evidencia.yaEraTicket, true);
  }));

test("sesión caducada: requiere intervención y no se reintenta; error transitorio: se reintenta hasta el límite", () =>
  conEntorno(ENV_TICKETS, async () => {
    const almacen = await preparar(); const mundo = new MundoHolded();
    await procesarColaTickets({ almacen, leer: mundo.leer, navegador: () => navegadorTickets(mundo, () => ({ estado: "sesion_caducada", detalle: "caducó" })) });
    assert.equal((await almacen.obtener(claveTicket("Footprint", "c1")))?.estado, "requiere_intervencion");

    const a2 = await preparar(); 
    for (let i = 0; i < 3; i++) await procesarColaTickets({ almacen: a2, leer: mundo.leer, navegador: () => navegadorTickets(mundo, () => ({ estado: "error", detalle: "fallo" })) });
    const t = await a2.obtener(claveTicket("Footprint", "c1"));
    assert.equal(t?.estado, "fallido"); assert.equal(t?.intentos, 3);
  }));

test("una lectura fallida de Holded no se interpreta: el caso queda en cola, sin tocar nada", () =>
  conEntorno(ENV_TICKETS, async () => {
    const almacen = await preparar(); const mundo = new MundoHolded(); mundo.fallaLectura = true;
    let abierto = false;
    await procesarColaTickets({ almacen, leer: mundo.leer, navegador: () => { abierto = true; return undefined; } });
    assert.equal(abierto, false);
    assert.equal((await almacen.obtener(claveTicket("Footprint", "c1")))?.estado, "solicitado");
  }));

test("simulación: lee y registra, nunca abre el navegador; el alcance de un caso controlado limita los ids", () =>
  conEntorno({ WOBI_HOLDED_TICKETS_MODO: "simulacion" }, async () => {
    const almacen = new AlmacenTrabajosMemoria();
    for (const id of ["c1", "otro"]) await almacen.guardar({ clave: claveTicket("Footprint", id), tipo: "ticket", empresa: "Footprint", objetivo: id, estado: "solicitado", intentos: 0, creadoEn: 1, actualizadoEn: 1, evidencia: {} });
    const mundo = new MundoHolded();
    let abierto = false;
    const r = await procesarColaTickets({ almacen, leer: mundo.leer, soloIds: new Set(["c1"]), navegador: () => { abierto = true; return undefined; } });
    assert.equal(abierto, false);
    assert.equal(r.revisados, 1);
    assert.equal((await almacen.obtener(claveTicket("Footprint", "otro")))?.estado, "solicitado");
  }));

test("ejecuciones duplicadas simultáneas sobre el mismo gasto: el navegador se usa una sola vez", () =>
  conEntorno(ENV_TICKETS, async () => {
    const almacen = await preparar(); const mundo = new MundoHolded();
    let usos = 0;
    const nav = () => navegadorTickets(mundo, (m) => { usos++; m.listado.delete("c1"); return { estado: "ok" }; });
    await Promise.all([procesarColaTickets({ almacen, leer: mundo.leer, navegador: nav }), procesarColaTickets({ almacen, leer: mundo.leer, navegador: nav })]);
    assert.equal(usos, 1);
  }));

test("instantánea: ignora el orden de etiquetas y detecta cambios reales", () => {
  assert.deepEqual(diferenciasInstantanea(instantaneaCompra(compra()), instantaneaCompra(compra({ tags: ["a", "b"] }))), []);
  assert.deepEqual(diferenciasInstantanea(instantaneaCompra(compra()), instantaneaCompra(compra({ total: "10,01" }))), ["total"]);
});

test("inventario de candidatos antiguos: solo lectura; probable solo con proveedor de fuera de la UE sin identificación fiscal; el resto, a revisión", async () => {
  const leer = async (_e: string, ruta: string) => {
    if (ruta === "/purchases") return { items: [{ id: "1", contact_id: "x", contact_name: "Uber", date: "2026-09-01", total: "5,00", currency: "USD", payments_total: "5,00" }, { id: "2", contact_id: "y", contact_name: "DHL Spain", date: "2026-09-02", total: "9,00", currency: "EUR", payments_total: "0,00" }], has_more: false };
    return ruta.endsWith("/x") ? { code: "", bill_address: { country_code: "US" } } : { code: "B123", bill_address: { country_code: "ES" } };
  };
  const c = await inventarioCandidatos("Footprint", "2026-09-01", "2026-09-30", leer);
  assert.deepEqual(c.map((x) => [x.compraId, x.nivel, x.conciliado]), [["1", "probable", true], ["2", "revisar", false]]);
});

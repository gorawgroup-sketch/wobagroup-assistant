import assert from "node:assert/strict";
import test from "node:test";
import {
  ConflictoConciliacionMovimientoError,
  conciliacionRequiereRevision,
  ejecutarConciliacionMovimientoDurable,
  identidadConciliacionMovimiento,
  type RegistroConciliacionMovimiento,
  type RepositorioConciliacionesMovimiento,
  type ResultadoConciliacionMovimiento,
} from "./durableBankReconciliation";
import { PROCESO_CONCILIACION_CARGO_MAYOR, margenRestoCargoMayor } from "./cargoMayor";

// Holded simulado y de solo lectura: cualquier escritura rompe la prueba.
process.env.HOLDED_API_KEY_WRITE_FOOTPRINT = "clave-de-prueba";
process.env.HOLDED_API_KEY_FOOTPRINT = "clave-de-prueba";
function simularHolded(movimiento: Record<string, unknown>, compra: Record<string, unknown>) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if ((init?.method ?? "GET") !== "GET") throw new Error(`ESCRITURA BLOQUEADA: ${init?.method} ${u}`);
    const cuerpo = u.includes("/bank-movements") ? { items: [movimiento], has_more: false }
      : u.includes("/treasury/accounts") ? { items: [{ id: "cta", name: "FTG USD", currency: "USD", archived: false }] }
      : u.includes("/purchases/") ? compra : {};
    return new Response(JSON.stringify(cuerpo), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
const compra = (id: string, total: string) =>
  ({ id, currency: "usd", total, payments_total: "0", payments_pending: total, payments_detail: [] });
const cargo = (extra: Record<string, unknown>) =>
  ({ id: "mov", status: "pending", amount: "-744.87", reconciled_amount: "0.00", currency: "USD", booking_date: "2026-09-25", ...extra });

async function validar(permitirCargoMayor: boolean, doc: string): Promise<string> {
  const w = await import("./write");
  try {
    await w.validarCompraContraMovimiento("Footprint", doc, "cta", "mov", "2026-09-25", false, permitirCargoMayor);
    return "ok";
  } catch (error) {
    return (error as Error).message;
  }
}

test("primer gasto contra un cargo mayor: solo pasa si el operador lo eligió (permitirCargoMayor)", async () => {
  const w = await import("./write");
  simularHolded(cargo({}), compra("doc1", "354,62"));
  assert.equal(await w.movimientoConRestoParaConciliar("Footprint", "cta", "mov", "2026-09-25", 354.62), true);
  assert.equal(await validar(true, "doc1"), "ok");
  assert.match(await validar(false, "doc1"), /el documento suma 354\.62 USD y el movimiento suma 744\.87 USD/);
});

test("segundo gasto: el resto de un cargo ya parcial se lee bien (el importe conciliado llega con punto decimal)", async () => {
  const w = await import("./write");
  simularHolded(cargo({ status: "partial", reconciled_amount: "-354.62" }), compra("doc2", "390,25"));
  assert.equal(await w.movimientoConRestoParaConciliar("Footprint", "cta", "mov", "2026-09-25", 390.25), true);
  assert.equal(await validar(true, "doc2"), "ok");
});

test("segundo gasto: si Holded enlazó de menos el primero (redondeo de tasa), el resto mayor sigue valiendo", async () => {
  const w = await import("./write");
  simularHolded(cargo({ status: "partial", reconciled_amount: "-354.60" }), compra("doc2", "390,25"));
  assert.equal(await w.movimientoConRestoParaConciliar("Footprint", "cta", "mov", "2026-09-25", 390.25), true);
  assert.equal(await validar(true, "doc2"), "ok");
});

test("un documento mayor que lo que queda libre se rechaza antes de escribir, aunque sea por céntimos", async () => {
  const w = await import("./write");
  simularHolded(cargo({ status: "partial", reconciled_amount: "-355.10" }), compra("doc2", "390,25"));
  assert.equal(await w.movimientoConRestoParaConciliar("Footprint", "cta", "mov", "2026-09-25", 390.25), false);
  assert.match(await validar(true, "doc2"), /le quedan 389\.77 USD sin asignar/);
});

test("no se concilia si al cargo no le queda sitio, si ya está conciliado o si no es un cargo", async () => {
  const w = await import("./write");
  simularHolded(cargo({ status: "partial", reconciled_amount: "-700.50" }), compra("doc2", "390,25"));
  assert.equal(await w.movimientoConRestoParaConciliar("Footprint", "cta", "mov", "2026-09-25", 390.25), false);
  assert.match(await validar(true, "doc2"), /le quedan 44\.37 USD sin asignar/);

  simularHolded(cargo({ status: "reconciled", reconciled_amount: "-744.87" }), compra("doc2", "390,25"));
  assert.equal(await w.movimientoConRestoParaConciliar("Footprint", "cta", "mov", "2026-09-25", 390.25), false);
  assert.match(await validar(true, "doc2"), /No es seguro conciliar/);

  simularHolded(cargo({ amount: "744.87" }), compra("doc1", "354,62"));
  assert.match(await validar(true, "doc1"), /no es un cargo/);
});

test("el margen del resto es el mismo que el de residuos de conversión", async () => {
  const w = await import("./write");
  for (const importe of [1, 3.99, 10.95, 354.62, 390.25, 5000]) {
    assert.equal(margenRestoCargoMayor(importe), w.margenResiduoConversion(importe));
  }
});

// Repositorio en memoria con la misma semántica que el almacén real: reservar devuelve el registro existente.
function repositorio(): RepositorioConciliacionesMovimiento & { filas: Map<string, RegistroConciliacionMovimiento> } {
  const filas = new Map<string, RegistroConciliacionMovimiento>();
  const cambiar = async (clave: string, de: string[], a: RegistroConciliacionMovimiento["estado"]) => {
    const actual = filas.get(clave);
    if (!actual || !de.includes(actual.estado)) return undefined;
    const siguiente = { ...actual, estado: a };
    filas.set(clave, siguiente);
    return siguiente;
  };
  return {
    filas,
    async reservar(r) { const e = filas.get(r.clave); if (e) return { registro: e, nuevo: false }; filas.set(r.clave, r); return { registro: r, nuevo: true }; },
    async obtener(c) { return filas.get(c); },
    async actualizarPreparada(c, r) {
      const a = filas.get(c);
      if (!a || a.estado !== "preparada") return undefined;
      const s = { ...a, documentId: r.documentId, huellaSolicitud: r.huellaSolicitud };
      filas.set(c, s);
      return s;
    },
    marcarConciliando: (c) => cambiar(c, ["preparada"], "conciliando"),
    async marcarPreparada(c) { await cambiar(c, ["conciliando"], "preparada"); },
    async marcarIncierta(c) { await cambiar(c, ["conciliando"], "incierta"); },
    async marcarVerificada(c, resultado: ResultadoConciliacionMovimiento) {
      filas.set(c, { ...filas.get(c)!, estado: conciliacionRequiereRevision(resultado) ? "verificada_revision" : "verificada" });
    },
    async marcarCancelada() {},
    async listarPendientes() { return []; },
  };
}

const identidad = (documento: string, porDocumento: boolean) => identidadConciliacionMovimiento(
  "Footprint", "cta", "mov", documento, "2026-09-25",
  porDocumento ? PROCESO_CONCILIACION_CARGO_MAYOR : "conciliacion_movimiento_aprobada", 1, porDocumento
);

async function conciliar(repo: ReturnType<typeof repositorio>, registro: RegistroConciliacionMovimiento, resultado: ResultadoConciliacionMovimiento) {
  let aplicado = false;
  let envios = 0;
  const ejecucion = await ejecutarConciliacionMovimientoDurable(registro, repo, {
    inspeccionar: async () => aplicado
      ? { estado: "verificada", resultado }
      : { estado: "libre", resultado: { ok: false, statusFinal: "pending", montoEnlazado: 0 } },
    conciliar: async () => { envios++; aplicado = true; },
  });
  return { ejecucion, envios };
}

test("dos gastos contra el mismo cargo mayor: cada uno tiene su registro y el segundo sí se concilia", async () => {
  const repo = repositorio();
  const primero = identidad("doc1", true);
  const segundo = identidad("doc2", true);
  assert.notEqual(primero.clave, segundo.clave);

  const r1 = await conciliar(repo, primero, { ok: true, statusFinal: "partial", montoEnlazado: 354.62, restoEsperadoEnMovimiento: 390.25 });
  assert.equal(r1.envios, 1);
  // El parcial elegido no es una incidencia: queda «verificada», no «verificada con revisión».
  assert.equal(repo.filas.get(primero.clave)!.estado, "verificada");

  const r2 = await conciliar(repo, segundo, { ok: true, statusFinal: "reconciled", montoEnlazado: 744.87 });
  assert.equal(r2.envios, 1);
  assert.equal(repo.filas.get(segundo.clave)!.estado, "verificada");
});

test("fuera del cargo mayor el registro sigue siendo uno por movimiento y un segundo documento se rechaza sin enviar nada", async () => {
  const repo = repositorio();
  const primero = identidad("doc1", false);
  const segundo = identidad("doc2", false);
  assert.equal(primero.clave, segundo.clave);
  await conciliar(repo, primero, { ok: true, statusFinal: "reconciled", montoEnlazado: 744.87 });
  let envios = 0;
  await assert.rejects(
    ejecutarConciliacionMovimientoDurable(segundo, repo, {
      inspeccionar: async () => ({ estado: "libre", resultado: { ok: false, statusFinal: "reconciled", montoEnlazado: 744.87 } }),
      conciliar: async () => { envios++; },
    }),
    ConflictoConciliacionMovimientoError
  );
  assert.equal(envios, 0);
});

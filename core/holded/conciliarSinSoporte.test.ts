import assert from "node:assert/strict";
import test from "node:test";
import { esAccionSensible } from "../telegram/authorizedUsersSheet";
import { ejecutarResto, evaluarRestoDeCargo, textoPropuestaGasto, textoPropuestaPar, textoPropuestaResto, type DatosResto, type DepsResto, type PropuestaSinSoporte } from "./conciliarSinSoporte";
import { claveResto, elegirRestoAprendido, restoDesdeFila, type RestoCargoAprendido } from "./restoCargoAprendidoSheet";

test("el cierre de cargo + reembolso dice qué cambia y que no se crea gasto", () => {
  const t = textoPropuestaPar("Footprint", { motivo: "reembolso total confirmado por Alejandro", descripcion: "Rappi* Verif", importe: 0.83, moneda: "USD", movimientos: [{ cuentaId: "c", movimientoId: "a", fecha: "2026-09-04" }, { cuentaId: "c", movimientoId: "b", fecha: "2026-09-05" }] });
  assert.match(t, /Cerrar cargo \+ reembolso sin gasto — Footprint/);
  assert.match(t, /0,83 USD de salida \(04\/09\/2026\) y 0,83 USD de entrada \(05\/09\/2026\)\. Suman cero/);
  assert.match(t, /Antes: los dos movimientos están pendientes/);
  assert.match(t, /No se crea gasto ni asiento: el efecto contable neto es cero/);
});

test("el gasto sin soporte dice proveedor, cuenta, etiquetas, que va SIN adjunto y que sí queda en la contabilidad", () => {
  const t = textoPropuestaGasto("Footprint", { motivo: "el recibo no existe", descripcion: "Payu*uber", importe: 7.37, moneda: "EUR", concepto: "Traslado Uber — Alejandro Florez — 23 sep 2026", movimiento: { cuentaId: "c", movimientoId: "m", fecha: "2026-09-23" }, plantilla: { compraId: "g", contactId: "k", proveedor: "Uber", cuentaId: "a", tags: ["alejandroflorez", "taxi", "transporte"] } }, "2026-09-23");
  assert.match(t, /Crear gasto SIN soporte y conciliarlo — Footprint/);
  assert.match(t, /Cargo: Payu\*uber · 7,37 EUR · 23\/09\/2026/);
  assert.match(t, /Antes: el cargo está pendiente de conciliar en Holded y no hay gasto/);
  assert.match(t, /SIN adjunto, con el proveedor Uber/);
  assert.match(t, /alejandroflorez, taxi, transporte/);
  assert.match(t, /«Traslado Uber — Alejandro Florez — 23 sep 2026 — SIN SOPORTE»/);
  assert.match(t, /Queda en la contabilidad/);
});

test("los botones son de superadmin y caben en el callback de Telegram", () => {
  assert.equal(esAccionSensible("sinsop_ok:ab12cd34"), true);
  assert.equal(esAccionSensible("sinsop_no:ab12cd34"), true);
  assert.ok(Buffer.byteLength("sinsop_ok:ab12cd34") <= 64);
});

/* ───── modo «resto»: el excedente de un cargo mayor como gasto bancario (Carlos, 2026-10-16) ───── */

// Caso real: Nicolás Gómez, gasto de 1.500 USD, transferencia de 1.503,00 USD; Holded enlazó 1.502,47 y dejó 0,53 USD.
const cargoParcial = { status: "partial", amount: "-1503.00", reconciled_amount: "-1502.47", currency: "USD" };

test("evaluarRestoDeCargo: solo un cargo conciliado en parte con un resto pequeño es una comisión", () => {
  assert.deepEqual(evaluarRestoDeCargo(cargoParcial), { resto: 0.53, importe: 1503 });
  const motivo = (e: Parameters<typeof evaluarRestoDeCargo>[0]) => { const r = evaluarRestoDeCargo(e); return typeof r === "string" ? r : "OK"; };
  assert.match(motivo({ ...cargoParcial, status: "reconciled" }), /ya figura conciliado/);
  assert.match(motivo({ ...cargoParcial, status: "pending", reconciled_amount: "0.00" }), /no conciliado en parte/);
  assert.match(motivo({ ...cargoParcial, amount: "1503.00" }), /cargo de salida/);
  assert.match(motivo({ ...cargoParcial, reconciled_amount: "-1503.00" }), /no le queda resto/);
  assert.match(motivo({ ...cargoParcial, reconciled_amount: "-1000.00" }), /no parece una comisión/);
});

const datosResto: DatosResto = {
  motivo: "comisión de la transferencia", descripcion: "To Nicolas David Gpmez Osorio Monthly Fee August", moneda: "USD", importeCargo: 1503, resto: 0.53, proveedor: "NICOLAS DAVID GOMEZ OSORIO",
  movimiento: { cuentaId: "ftg-usd", movimientoId: "mov-1", fecha: "2026-09-11" },
  plantilla: { compraId: "plantilla-1", contactId: "revolut", proveedor: "REVOLUT BANK UAB SUCURSAL EN ESPAÑA.", cuentaId: "626", tags: ["banco"] }, aprendida: false,
};
const propuesta = { id: "p1", modo: "resto", empresa: "Footprint", chatId: 7, creadoEn: Date.now(), datos: datosResto } as PropuestaSinSoporte;

test("el texto dice antes/ahora, el proveedor del banco, la descripción del cargo y el precedente", () => {
  const t = textoPropuestaResto("Footprint", datosResto);
  assert.match(t, /Registrar el resto del cargo como GASTO BANCARIO — Footprint/);
  assert.match(t, /1503,00 USD · 11\/09\/2026\. Ya está conciliado con su gasto salvo 0,53 USD/);
  assert.match(t, /Antes: al cargo le quedan 0,53 USD sin conciliar/);
  assert.match(t, /SIN adjunto, con el proveedor REVOLUT BANK UAB SUCURSAL EN ESPAÑA\./);
  assert.match(t, /«To Nicolas David Gpmez Osorio Monthly Fee August»/);
  assert.match(t, /el cargo queda conciliado al 100 %/);
  assert.match(t, /la plantilla que indicaste/);
  assert.match(textoPropuestaResto("Footprint", { ...datosResto, aprendida: true }), /tratamiento aprendido/);
});

function depsResto(sobre: Partial<DepsResto> = {}) {
  const llamadas = { creados: [] as unknown[][], reconciliados: [] as unknown[][], aprendidos: [] as unknown[][], lecturas: 0 };
  const deps: DepsResto = {
    leerMovimiento: async () => { llamadas.lecturas++; return llamadas.reconciliados.length ? { status: "reconciled", amount: "-1503.00", reconciled_amount: "-1503.00", currency: "USD" } : cargoParcial; },
    crearGasto: async (...a: unknown[]) => { llamadas.creados.push(a); return { id: "gasto-banco" }; },
    reconciliar: async (...a: unknown[]) => { llamadas.reconciliados.push(a); return { ok: true, statusFinal: "reconciled" } as never; },
    aprender: async (...a: unknown[]) => { llamadas.aprendidos.push(a); },
    ...sobre,
  } as DepsResto;
  return { deps, llamadas };
}

test("ejecutar: crea el gasto bancario con los datos del precedente, concilia el resto, verifica y aprende", async () => {
  const { deps, llamadas } = depsResto();
  const msg = await ejecutarResto(propuesta, datosResto, deps);
  assert.match(msg, /Gasto bancario registrado y conciliado: 0,53 USD/);
  assert.match(msg, /conciliado al 100 %/);
  const [empresa, gasto, contexto] = llamadas.creados[0] as [string, Record<string, unknown>, Record<string, unknown>];
  assert.equal(empresa, "Footprint");
  assert.equal(gasto.contactId, "revolut");
  assert.equal(gasto.descripcion, "To Nicolas David Gpmez Osorio Monthly Fee August");
  assert.deepEqual(gasto.lineas, [{ concepto: "To Nicolas David Gpmez Osorio Monthly Fee August", base: 0.53, tipoIvaPct: 0, tratamientoFiscal: "sin_impuesto" }]);
  assert.equal(gasto.moneda, "USD"); assert.equal(gasto.fecha, "2026-09-11"); assert.equal(gasto.cuentaId, "626"); assert.deepEqual(gasto.tags, ["banco"]);
  assert.equal(contexto.idempotencyKey, "resto-banco:Footprint:ftg-usd:mov-1:53", "la clave es del cargo y su resto, no de la propuesta");
  assert.deepEqual(llamadas.reconciliados[0], ["Footprint", "ftg-usd", "mov-1", "2026-09-11", "gasto-banco", { permitirCargoMayor: true }]);
  assert.equal(llamadas.aprendidos.length, 1);
  assert.equal((llamadas.aprendidos[0][0] as { plantillaCompraId: string }).plantillaCompraId, "plantilla-1");
});

test("ejecutar: si el cargo o su resto cambiaron en Holded, no se crea nada", async () => {
  for (const cambiado of [{ status: "reconciled", amount: "-1503.00", reconciled_amount: "-1503.00" }, { ...cargoParcial, reconciled_amount: "-1502.00" }]) {
    const { deps, llamadas } = depsResto({ leerMovimiento: async () => cambiado as never });
    const msg = await ejecutarResto(propuesta, datosResto, deps);
    assert.match(msg, /ya cambió|cambió en Holded/);
    assert.equal(llamadas.creados.length, 0);
    assert.equal(llamadas.reconciliados.length, 0);
  }
  const { deps, llamadas } = depsResto({ leerMovimiento: async () => undefined });
  assert.match(await ejecutarResto(propuesta, datosResto, deps), /No pude releer/);
  assert.equal(llamadas.creados.length, 0);
});

test("ejecutar: si la conciliación no queda confirmada, lo dice con el id del gasto, no repite y no aprende", async () => {
  const { deps, llamadas } = depsResto({ reconciliar: async () => ({ ok: false, statusFinal: "partial" }) as never });
  const msg = await ejecutarResto(propuesta, datosResto, deps);
  assert.match(msg, /Creé el gasto bancario en Holded \(id gasto-banco\)[\s\S]*No repito nada/);
  assert.equal(llamadas.aprendidos.length, 0);
});

test("ejecutar: una propuesta caducada no crea nada", async () => {
  const { deps, llamadas } = depsResto();
  assert.match(await ejecutarResto({ ...propuesta, creadoEn: Date.now() - 49 * 3600_000 }, datosResto, deps), /caducó/);
  assert.equal(llamadas.creados.length, 0);
});

test("ejecutar: si la conciliación lanza una excepción, el mensaje lleva el id del gasto creado y no aprende", async () => {
  const { deps, llamadas } = depsResto({ reconciliar: async () => { throw new Error("Holded 502"); } });
  const msg = await ejecutarResto(propuesta, datosResto, deps);
  assert.match(msg, /Creé el gasto bancario en Holded \(id gasto-banco\)[\s\S]*Holded 502[\s\S]*se reutiliza ese mismo gasto/);
  assert.equal(llamadas.aprendidos.length, 0);
});

test("ejecutar: dos pulsaciones simultáneas sobre el mismo cargo crean un solo gasto", async () => {
  let conciliado = false;
  const { deps, llamadas } = depsResto({
    leerMovimiento: async () => { await new Promise((r) => setTimeout(r, 5)); return conciliado ? { status: "reconciled", amount: "-1503.00", reconciled_amount: "-1503.00", currency: "USD" } : cargoParcial; },
    reconciliar: async () => { conciliado = true; return { ok: true, statusFinal: "reconciled" } as never; },
  });
  const [a, b] = await Promise.all([ejecutarResto(propuesta, datosResto, deps), ejecutarResto({ ...propuesta, id: "p2" }, datosResto, deps)]);
  assert.equal(llamadas.creados.length, 1);
  assert.equal([a, b].filter((m) => /Gasto bancario registrado/.test(m)).length, 1);
});

test("ejecutar: si tras conciliar el cargo no figura completo, avisa; un fallo al aprender no rompe el resultado", async () => {
  const { deps } = depsResto({ leerMovimiento: async () => cargoParcial as never, aprender: async () => { throw new Error("Sheets caído"); } });
  const msg = await ejecutarResto(propuesta, datosResto, deps);
  assert.match(msg, /aún no figura conciliado por completo/);
  const ok = depsResto({ aprender: async () => { throw new Error("Sheets caído"); } });
  assert.match(await ejecutarResto(propuesta, datosResto, ok.deps), /conciliado al 100 %/);
});

const aprendido = (o: Partial<RestoCargoAprendido>): RestoCargoAprendido => ({ rowIndex: 2, clave: "", empresa: "Footprint", proveedor: "Nicolás Gómez", moneda: "USD", plantillaCompraId: "p-a", contactId: "revolut", proveedorBanco: "REVOLUT", tags: [], veces: 1, actualizadoEn: "2026-10-16T10:00:00Z", ...o });

test("aprendizaje: se reutiliza el tratamiento de la misma persona y moneda; si no, el más usado de la empresa en esa moneda", () => {
  const registros = [
    aprendido({ clave: claveResto("Footprint", "Nicolás Gómez", "USD"), plantillaCompraId: "p-nicolas" }),
    aprendido({ proveedor: "Kelly", clave: claveResto("Footprint", "Kelly", "USD"), plantillaCompraId: "p-kelly", veces: 5 }),
    aprendido({ proveedor: "Otra", moneda: "COP", clave: claveResto("Footprint", "Otra", "COP"), plantillaCompraId: "p-cop", veces: 9 }),
    aprendido({ empresa: "WOBA", proveedor: "X", clave: claveResto("WOBA", "X", "USD"), plantillaCompraId: "p-woba", veces: 20 }),
  ];
  assert.equal(elegirRestoAprendido(registros, "Footprint", "nicolas gomez", "usd")?.plantillaCompraId, "p-nicolas", "acentos y mayúsculas no importan");
  assert.equal(elegirRestoAprendido(registros, "Footprint", "Alguien nuevo", "USD")?.plantillaCompraId, "p-kelly");
  assert.equal(elegirRestoAprendido(registros, "EWORKS", "Alguien", "USD"), undefined);
});

test("aprendizaje: filas del almacén ilegibles se ignoran y las etiquetas rotas no tumban la lectura", () => {
  assert.equal(restoDesdeFila(2, ["", "Footprint", "x", "USD", "p", "c"]), undefined);
  assert.equal(restoDesdeFila(2, ["k", "Otra", "x", "USD", "p", "c"]), undefined);
  assert.deepEqual(restoDesdeFila(2, ["k", "Footprint", "Nicolás", "usd", "p", "c", "REVOLUT", "626", "{no es json", "3", "2026-10-16"])?.tags, []);
  assert.equal(restoDesdeFila(2, ["k", "Footprint", "Nicolás", "usd", "p", "c", "REVOLUT", "626", '["banco"]', "3", "2026-10-16"])?.veces, 3);
});


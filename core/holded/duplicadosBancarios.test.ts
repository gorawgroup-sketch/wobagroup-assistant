import assert from "node:assert/strict";
import test from "node:test";
import { avisarDuplicadosBancarios, creadoEnDeId, detectarLotesDeCopias, esCopiaPendienteDeConciliado, firmasConciliadas, textoAvisoDuplicados, type CuentaConMovimientos, type MovimientoBancario } from "./duplicadosBancarios";

// Caso real 14-10-2026 (WOBA Main): Anthropic −21,63 del 08/10 duplicado (una conciliada, una pendiente).
test("la copia pendiente de un cargo ya conciliado se reconoce; un cargo distinto del mismo proveedor no", () => {
  const lista = [
    { description: "Anthropic", amount: "-21.63", booking_date: "2026-10-08T00:00:00+00:00", status: "reconciled" },
    { description: "Anthropic", amount: "-21.63", booking_date: "2026-10-08T00:00:00+00:00", status: "pending" },
    { description: "Anthropic", amount: "-21.61", booking_date: "2026-10-13T00:00:00+00:00", status: "pending" },
  ];
  const firmas = firmasConciliadas(lista);
  assert.equal(esCopiaPendienteDeConciliado(lista[1], firmas), true);
  assert.equal(esCopiaPendienteDeConciliado(lista[2], firmas), false, "el cargo real del 13/10 sigue siendo candidato");
  assert.equal(esCopiaPendienteDeConciliado(lista[0], firmas), false, "el conciliado no es «copia»");
});

/**
 * Caso real (WOBA Main, Revolut, 15-10-2026): 16 copias creadas todas el 14-10 09:54 UTC de movimientos que habían entrado en las sincronizaciones
 * diarias de la semana anterior; el saldo corrido de cada copia difiere del original en 2,51 €. Los «iguales» de Footprint eran cargos reales.
 */
const hex = (epochMs: number, sufijo: string): string => Math.floor(epochMs / 1000).toString(16).padStart(8, "0") + sufijo.padStart(16, "0");
const ORIGINAL = Date.UTC(2026, 9, 6, 4, 2);
const LOTE = Date.UTC(2026, 9, 14, 9, 54);
let n = 0;
const mov = (o: Partial<MovimientoBancario> & { creado: number }): MovimientoBancario => ({ id: hex(o.creado, String(++n)), fecha: "2026-10-05", monto: -160.2, descripcion: "To TRANSMEC", saldo: 4000, estado: "pending", ...o });
const par = (fecha: string, monto: number, descripcion: string, saldo: number, desfase = 2.51, estadoCopia = "pending") => [
  mov({ creado: ORIGINAL, fecha, monto, descripcion, saldo, estado: "reconciled" }),
  mov({ creado: LOTE, fecha, monto, descripcion, saldo: saldo + desfase, estado: estadoCopia }),
];
const cuenta = (movimientos: MovimientoBancario[]): CuentaConMovimientos => ({ empresa: "WOBA", cuentaId: "acc1", cuenta: "Main", movimientos });

test("el instante de creación sale de los 4 primeros bytes del id; un id raro no rompe", () => {
  assert.equal(creadoEnDeId(hex(LOTE, "1")), Math.floor(LOTE / 1000) * 1000);
  assert.ok(Number.isNaN(creadoEnDeId("abc")));
});

test("caso real: copias creadas en el mismo lote con el mismo desfase de saldo → un lote con todas las copias", () => {
  const lotes = detectarLotesDeCopias(cuenta([
    ...par("2026-10-05", -160.2, "To TRANSMEC", 4145.99), ...par("2026-10-05", -600, "To Business Atelier", 7754.47), ...par("2026-10-06", 444.16, "Payment from Housfy", 4058.17),
  ]));
  assert.equal(lotes.length, 1);
  assert.equal(lotes[0].pares.length, 3);
  assert.equal(lotes[0].desfaseSaldo, 2.51);
});

test("dos cargos reales iguales el mismo día (el saldo difiere justo en el importe) nunca son copias", () => {
  const a = mov({ creado: ORIGINAL, fecha: "2026-10-09", monto: -0.35, descripcion: "To SEGURIDAD SOCIAL", saldo: 2419.71, estado: "pending" });
  const b = mov({ creado: LOTE, fecha: "2026-10-09", monto: -0.35, descripcion: "To SEGURIDAD SOCIAL", saldo: 2419.36 });
  const c = mov({ creado: ORIGINAL, fecha: "2026-10-09", monto: -36, descripcion: "Air Europa", saldo: 437.01 });
  const d = mov({ creado: LOTE, fecha: "2026-10-09", monto: -36, descripcion: "Air Europa", saldo: 401.01 });
  assert.deepEqual(detectarLotesDeCopias(cuenta([a, b, c, d])), []);
});

test("un par aislado no se avisa: sin lote no se distingue de un segundo cargo real publicado otro día", () => {
  assert.deepEqual(detectarLotesDeCopias(cuenta(par("2026-10-05", -160.2, "To TRANSMEC", 4145.99))), []);
});

test("movimientos iguales creados en la misma sincronización (menos de 6 h) no son copias", () => {
  const a = mov({ creado: LOTE, saldo: 100 }), b = mov({ creado: LOTE + 60_000, saldo: 107.77 });
  const c = mov({ creado: LOTE, fecha: "2026-10-06", saldo: 50, monto: -10, descripcion: "X" }), d = mov({ creado: LOTE + 60_000, fecha: "2026-10-06", saldo: 57.77, monto: -10, descripcion: "X" });
  assert.deepEqual(detectarLotesDeCopias(cuenta([a, b, c, d])), []);
});

test("desfases distintos o lotes separados más de 30 minutos no se mezclan", () => {
  const distintos = detectarLotesDeCopias(cuenta([...par("2026-10-05", -160.2, "To TRANSMEC", 4145.99, 2.51), ...par("2026-10-05", -600, "To Business Atelier", 7754.47, 3.1)]));
  assert.deepEqual(distintos, []);
  const lejos = mov({ creado: LOTE + 3_600_000, fecha: "2026-10-06", monto: -5, descripcion: "Z", saldo: 12.51 });
  const origenLejos = mov({ creado: ORIGINAL, fecha: "2026-10-06", monto: -5, descripcion: "Z", saldo: 10, estado: "reconciled" });
  assert.deepEqual(detectarLotesDeCopias(cuenta([...par("2026-10-05", -160.2, "To TRANSMEC", 4145.99), origenLejos, lejos])), []);
});

test("el aviso cuenta pendientes y conciliadas, no repite el lote ya avisado y en simulación no avisa ni marca", async () => {
  const cuentas = [cuenta([...par("2026-10-05", -160.2, "To TRANSMEC", 4145.99), ...par("2026-10-01", -350, "To Business Atelier", 3565.71, 2.51, "reconciled")])];
  const avisos: string[] = [], marcados: string[] = [];
  const deps = (avisados: string[], simular = false) => ({ cuentas: async () => cuentas, yaAvisados: async () => new Set(avisados), marcarAvisados: async (c: string[]) => { marcados.push(...c); }, avisar: async (t: string) => { avisos.push(t); }, simular });
  const sim = await avisarDuplicadosBancarios(deps([], true));
  assert.equal(sim.nuevos.length, 1); assert.equal(avisos.length, 0); assert.equal(marcados.length, 0);
  const real = await avisarDuplicadosBancarios(deps([]));
  assert.equal(avisos.length, 1); assert.equal(marcados.length, 1);
  assert.match(avisos[0], /WOBA · Main: 2 copias/); assert.match(avisos[0], /Pendientes de conciliar: 1/); assert.match(avisos[0], /ya conciliadas por Holded: 1/);
  assert.match(avisos[0], /no de Wobi/); assert.doesNotMatch(avisos[0], /✅|❌/);
  const repetido = await avisarDuplicadosBancarios(deps([real.nuevos[0].clave]));
  assert.equal(repetido.nuevos.length, 0); assert.equal(avisos.length, 1);
});

test("el texto no se desborda con muchos lotes y copias", () => {
  const lote = { clave: "k", empresa: "WOBA" as const, cuentaId: "a", cuenta: "Main", creadoEn: LOTE, desfaseSaldo: 2.51, pares: Array.from({ length: 16 }, (_, i) => ({ copiaId: `c${i}`, originalId: `o${i}`, fecha: "2026-10-05", monto: -10, descripcion: `Cargo ${i}`, estadoCopia: "pending", estadoOriginal: "reconciled" })) };
  const t = textoAvisoDuplicados([lote, ...Array.from({ length: 6 }, (_, i) => ({ ...lote, clave: `k${i}` }))]);
  assert.match(t, /y 10 más/); assert.match(t, /y 2 lotes más/); assert.ok(t.length < 4000);
});

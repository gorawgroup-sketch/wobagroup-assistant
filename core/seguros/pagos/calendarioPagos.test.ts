import assert from "node:assert/strict";
import test from "node:test";
import type { CuentaCaja } from "./caja";
import { marcarAvisosEnviados, prepararCalendarioPagos, type DepsCalendarioPagos } from "./calendarioPagos";
import { pago } from "./pruebas";
import { pagosSembrados } from "./semilla";
import type { PagoSeguro, PagoSeguroConFila } from "./tipos";

const cuentasWoba: CuentaCaja[] = [
  { nombre: "BBVA ", moneda: "EUR", saldo: 654.81, tipo: "bank" },
  { nombre: "Main", moneda: "EUR", saldo: 4097.45, tipo: "bank" },
];
const cuentasEworks: CuentaCaja[] = [{ nombre: "CAIXA BANK EWORKS", moneda: "EUR", saldo: -20281.34, tipo: "bank" }];

function montar(hoy: string, pagos: PagoSeguro[], opciones: { cuentas?: Record<string, CuentaCaja[] | "falla">; calendarioCae?: boolean } = {}) {
  let filas: PagoSeguroConFila[] = pagos.map((p, i) => ({ ...p, rowIndex: i + 2 }));
  const eventos: string[] = [];
  const borrados: string[] = [];
  const lecturasDeCuentas: string[] = [];
  const deps: DepsCalendarioPagos = {
    hoy: () => hoy,
    leerPagos: async () => filas.map((f) => ({ ...f })),
    actualizar: async (p, cambios) => {
      const nuevo = { ...p, ...cambios };
      filas = filas.map((f) => (f.id === p.id ? nuevo : f));
      return nuevo;
    },
    cuentas: async (empresa) => {
      lecturasDeCuentas.push(empresa);
      const c = opciones.cuentas?.[empresa];
      if (c === "falla") throw new Error("Holded 503");
      return c ?? null;
    },
    crearEvento: async (e) => { if (opciones.calendarioCae) return null; eventos.push(e.resumen); return `evt_${eventos.length}`; },
    borrarEvento: async (id) => { borrados.push(id); },
  };
  return { deps, eventos, borrados, lecturasDeCuentas, filas: () => filas };
}

test("cada pago previsto recibe su evento de calendario (el día del evento, hoy o futuro) y no se crea dos veces", async () => {
  const m = montar("2026-10-06", pagosSembrados("2026-10-06T00:00:00.000Z"));
  const r = await prepararCalendarioPagos(m.deps);
  assert.equal(r.eventosCreados, 6);
  assert.equal(m.eventos.length, 6);
  assert.ok(m.filas().every((f) => f.eventoCalendarId.startsWith("evt_")));
  const otra = await prepararCalendarioPagos(m.deps);
  assert.equal(otra.eventosCreados, 0, "idempotente: ya tienen evento");
  assert.equal(m.eventos.length, 6);
});

test("un pago cuyo evento caería en el pasado no crea evento (el aviso cubre ese caso), y si el calendario falla se anota y se reintenta", async () => {
  const cercano = pago({ id: "a", fecha: "2027-03-01" });
  const m = montar("2027-02-28", [cercano]);
  assert.equal((await prepararCalendarioPagos(m.deps)).eventosCreados, 0, "el evento sería del 26/02, ya pasado");
  const caido = montar("2026-10-06", [pago({ id: "b", fecha: "2027-03-01" })], { calendarioCae: true });
  const r = await prepararCalendarioPagos(caido.deps);
  assert.equal(r.eventosCreados, 0);
  assert.match(r.advertencias[0], /No pude crear el evento de calendario de «Allianz showroom/);
  assert.equal(caido.filas()[0].eventoCalendarId, "", "queda sin evento para reintentar mañana");
});

test("el evento de un pago ya cerrado (pagado, devuelto o cancelado) se retira del calendario", async () => {
  const m = montar("2027-03-02", [pago({ id: "a", estado: "pagado", eventoCalendarId: "evt_viejo" }), pago({ id: "b", estado: "cancelado", eventoCalendarId: "evt_otro" })]);
  const r = await prepararCalendarioPagos(m.deps);
  assert.equal(r.eventosRetirados, 2);
  assert.deepEqual(m.borrados.sort(), ["evt_otro", "evt_viejo"]);
  assert.ok(m.filas().every((f) => f.eventoCalendarId === ""));
});

test("SIMULACIÓN con saldos reales (24-28/02/2027): avisa de EWORKS (cuenta con saldo negativo: no comprobable) y de los dos recibos de Allianz (BBVA no cubre 1.244,14 €), sin repetir lo ya avisado", async () => {
  const m = montar("2027-02-24", pagosSembrados("2026-10-06T00:00:00.000Z"), { cuentas: { WOBA: cuentasWoba, EWORKS: cuentasEworks } });
  // El 24/02 solo toca EWORKS (27/02 es dentro de 3 días): una sola lectura de cuentas, la de EWORKS.
  const dia24 = await prepararCalendarioPagos(m.deps);
  assert.deepEqual(m.lecturasDeCuentas, ["EWORKS"]);
  assert.equal(dia24.avisos.length, 1);
  assert.equal(dia24.avisos[0].caja.estado, "no_comprobable");
  assert.match(dia24.informe?.cuerpo ?? "", /\[EWORKS\] RC Markel 025S00287RCG — 1\.ª cuota semestral de la renovación 2027 · 840,74 € \(estimado\) · adeudo en «CAIXA BANK EWORKS»/);
  await marcarAvisosEnviados(m.deps, dia24.avisos);
  assert.equal(m.filas().find((f) => f.polizaId === "eworks_rc_markel" && f.fecha === "2027-02-27")?.avisos, "d3");

  // El 26/02 tocan las dos cuotas de Allianz (01/03, a 3 días): se suman en BBVA y no alcanzan. EWORKS (27/02) está a 1 día: recordatorio.
  const dia26 = await prepararCalendarioPagos({ ...m.deps, hoy: () => "2027-02-26" });
  assert.deepEqual(dia26.avisos.map((a) => `${a.pago.polizaId}:${a.nivel}`).sort(), [
    "eworks_rc_markel:d1",
    "woba_showroom_2026_2027:d3",
    "woba_showroom_complemento_2026_2027:d3",
  ]);
  for (const a of dia26.avisos.filter((x) => x.pago.empresa === "WOBA")) {
    assert.equal(a.caja.estado, "no_alcanza");
    if (a.caja.estado === "no_alcanza") { assert.equal(a.caja.necesario, 1244.14); assert.equal(a.caja.faltan, 589.33); assert.deepEqual(a.caja.otras, [{ nombre: "Main", saldo: 4097.45 }]); }
  }
  assert.match(dia26.informe?.titulo ?? "", /^⚠️/);
  await marcarAvisosEnviados(m.deps, dia26.avisos);

  // El 27/02 (EWORKS es el día del cargo; Allianz a 2 días y ya avisado) no se repite nada; el 28/02 llega el recordatorio de Allianz porque BBVA sigue sin alcanzar.
  assert.equal((await prepararCalendarioPagos({ ...m.deps, hoy: () => "2027-02-27" })).avisos.length, 0);
  const dia28 = await prepararCalendarioPagos({ ...m.deps, hoy: () => "2027-02-28" });
  assert.deepEqual(dia28.avisos.map((a) => a.nivel), ["d1", "d1"]);
});

test("un fallo de Holded al leer las cuentas no calla el aviso: sale «no pude comprobar la caja», con la advertencia", async () => {
  const m = montar("2027-02-26", [pago({ fecha: "2027-03-01" })], { cuentas: { WOBA: "falla" } });
  const r = await prepararCalendarioPagos(m.deps);
  assert.equal(r.avisos.length, 1);
  assert.equal(r.avisos[0].caja.estado, "no_comprobable");
  assert.match(r.advertencias.join(" "), /No pude leer las cuentas de WOBA en Holded: Holded 503/);
  assert.match(r.informe?.cuerpo ?? "", /❓ no pude comprobar la caja: no pude leer las cuentas de WOBA en Holded/);
});

test("las cuentas de una empresa se leen una sola vez aunque tenga varios pagos que avisar, y nada se lee si no hay nada que avisar", async () => {
  const dos = montar("2027-02-26", [pago({ id: "a", fecha: "2027-03-01" }), pago({ id: "b", fecha: "2027-03-01", importe: 289.14 })], { cuentas: { WOBA: cuentasWoba } });
  await prepararCalendarioPagos(dos.deps);
  assert.deepEqual(dos.lecturasDeCuentas, ["WOBA"]);
  const ninguno = montar("2026-10-06", [pago({ fecha: "2027-03-01" })], { cuentas: { WOBA: cuentasWoba } });
  const r = await prepararCalendarioPagos(ninguno.deps);
  assert.deepEqual(ninguno.lecturasDeCuentas, []);
  assert.equal(r.informe, null);
});

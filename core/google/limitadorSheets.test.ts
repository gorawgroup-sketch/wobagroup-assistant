import assert from "node:assert/strict";
import test from "node:test";
import { conCancelacionSheets, conPrioridadSheets, crearAdaptadorSheetsConCuota, esPeticionSheets, LimitadorVentana } from "./limitadorSheets";

function reloj() {
  let t = 1_000_000;
  const pendientes: Array<{ en: number; fn: () => void }> = [];
  return {
    deps: { ahora: () => t, programar: (fn: () => void, ms: number) => { pendientes.push({ en: t + ms, fn }); } },
    async avanzar(ms: number) {
      t += ms;
      for (const p of pendientes.splice(0).sort((a, b) => a.en - b.en)) { if (p.en <= t) p.fn(); else pendientes.push(p); }
      await new Promise((r) => setImmediate(r));
    },
  };
}
const respuesta = (status: number) => ({ status });
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets/abc/values/x";

test("dentro del máximo por minuto todo pasa al instante; lo que excede espera su turno y no falla", async () => {
  const r = reloj();
  const l = new LimitadorVentana(3, 0, 60_000, r.deps);
  await Promise.all([l.adquirir("interactiva"), l.adquirir("interactiva"), l.adquirir("interactiva")]);
  let cuarta = false;
  const espera = l.adquirir("interactiva").then(() => { cuarta = true; });
  await r.avanzar(30_000);
  assert.equal(cuarta, false);
  assert.equal(l.estado.enCola, 1);
  await r.avanzar(30_100);
  await espera;
  assert.equal(cuarta, true);
});

test("el trabajo de fondo cede una reserva y lo interactivo pasa primero", async () => {
  const r = reloj();
  const l = new LimitadorVentana(4, 2, 60_000, r.deps);
  await l.adquirir("fondo");
  await l.adquirir("fondo"); // el fondo solo puede ocupar 4 - 2 = 2
  const orden: string[] = [];
  const fondo = l.adquirir("fondo").then(() => orden.push("fondo"));
  await l.adquirir("interactiva").then(() => orden.push("interactiva-1")); // entra en la reserva sin esperar
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(orden, ["interactiva-1"]);
  await r.avanzar(60_100);
  await fondo;
  assert.deepEqual(orden, ["interactiva-1", "fondo"]);
});

test("una lectura vencida abandona la cola y no consume cuota después", async () => {
  const r = reloj();
  const l = new LimitadorVentana(1, 0, 60_000, r.deps);
  await l.adquirir("fondo");
  const abortar = new AbortController();
  const pendiente = l.adquirir("fondo", abortar.signal);
  assert.equal(l.estado.enCola, 1);
  abortar.abort(new Error("lectura vencida"));
  await assert.rejects(pendiente, /lectura vencida/);
  assert.equal(l.estado.enCola, 0);
  await r.avanzar(60_100);
  assert.equal(l.estado.enVentana, 0);
});

test("solo interviene en Sheets: Gmail, Drive y OAuth pasan intactos al adaptador por defecto", async () => {
  assert.equal(esPeticionSheets(SHEETS), true);
  assert.equal(esPeticionSheets("https://gmail.googleapis.com/gmail/v1/users/me/messages"), false);
  assert.equal(esPeticionSheets("https://sheets.googleapis.com.estafa.io/x"), false);
  let adquisiciones = 0;
  const limitador = { adquirir: async () => { adquisiciones++; } } as unknown as LimitadorVentana;
  const adaptador = crearAdaptadorSheetsConCuota({ limitadores: { lectura: limitador, escritura: limitador } });
  const vistas: unknown[] = [];
  const porDefecto = async (o: { url?: string }) => { vistas.push(o); return respuesta(200); };
  const gmail = { url: "https://oauth2.googleapis.com/token", method: "POST" };
  await adaptador(gmail, porDefecto);
  assert.equal(adquisiciones, 0);
  assert.equal(vistas[0], gmail); // el mismo objeto, sin tocar
  await adaptador({ url: SHEETS }, porDefecto);
  assert.equal(adquisiciones, 1);
});

test("un 429 en una lectura se reintenta tras la pausa; en una escritura se devuelve tal cual", async () => {
  const limitador = { adquirir: async () => undefined } as unknown as LimitadorVentana;
  const pausas: number[] = [];
  const estados = [429, 429, 200];
  let llamadas = 0;
  const adaptador = crearAdaptadorSheetsConCuota({ limitadores: { lectura: limitador, escritura: limitador },
    esperar: async (ms) => { pausas.push(ms); }, pausaTras429Ms: 7 });
  const porDefecto = async () => respuesta(estados[llamadas++] ?? 200);
  assert.equal((await adaptador({ url: SHEETS }, porDefecto)).status, 200);
  assert.equal(llamadas, 3);
  assert.deepEqual(pausas, [7, 7]);

  llamadas = 0; estados.splice(0, estados.length, 429, 200);
  assert.equal((await adaptador({ url: SHEETS, method: "PUT" }, porDefecto)).status, 429);
  assert.equal(llamadas, 1);
});

test("la prioridad de fondo viaja por el contexto asíncrono hasta la petición", async () => {
  const vistas: string[] = [];
  const limitador = { adquirir: async (p: string) => { vistas.push(p); } } as unknown as LimitadorVentana;
  const adaptador = crearAdaptadorSheetsConCuota({ limitadores: { lectura: limitador, escritura: limitador } });
  const porDefecto = async () => respuesta(200);
  await adaptador({ url: SHEETS }, porDefecto);
  await conPrioridadSheets("fondo", async () => { await new Promise((r) => setImmediate(r)); await adaptador({ url: SHEETS }, porDefecto); });
  assert.deepEqual(vistas, ["interactiva", "fondo"]);
});

test("el timeout empieza al salir de la cola, no mientras se esperaba turno", async () => {
  const limitador = { adquirir: async () => undefined } as unknown as LimitadorVentana;
  const adaptador = crearAdaptadorSheetsConCuota({ limitadores: { lectura: limitador, escritura: limitador } });
  let senal: AbortSignal | undefined;
  const porDefecto = async (o: { signal?: AbortSignal }) => { senal = o.signal; return respuesta(200); };
  await adaptador({ url: SHEETS, timeout: 45_000, signal: AbortSignal.abort() }, porDefecto);
  assert.ok(senal);
  assert.equal(senal!.aborted, false);
});

test("un consumidor cancelado no envía una lectura Sheets pendiente", async () => {
  const r = reloj();
  const l = new LimitadorVentana(1, 0, 60_000, r.deps);
  await l.adquirir("fondo");
  const adaptador = crearAdaptadorSheetsConCuota({ limitadores: { lectura: l, escritura: l } });
  const abortar = new AbortController();
  let enviadas = 0;
  const pendiente = conCancelacionSheets(abortar.signal, () =>
    adaptador({ url: SHEETS }, async () => { enviadas++; return respuesta(200); }));
  await new Promise((res) => setImmediate(res));
  assert.equal(l.estado.enCola, 1);
  abortar.abort(new Error("fuente vencida"));
  await assert.rejects(pendiente, /fuente vencida/);
  await r.avanzar(60_100);
  assert.equal(enviadas, 0);
});

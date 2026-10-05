import assert from "node:assert/strict";
import test from "node:test";
import { clasificarPeticionSheets, conCancelacionSheets, conPrioridadSheets, crearAdaptadorSheetsConCuota, esPeticionSheets, LimitadorVentana, origenDesdePila, usoSheetsReciente } from "./limitadorSheets";

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


test("clasificarPeticionSheets: pestaña de una lectura, escritura, batchGet y metadatos (sin valores de celdas)", () => {
  const base = "https://sheets.googleapis.com/v4/spreadsheets/1AbCdEfGhIjKlMnOpQrStUvWxYz";
  assert.deepEqual(clasificarPeticionSheets(`${base}/values/_gastos_pendientes!A2%3AAE10000?valueRenderOption=UNFORMATTED_VALUE`), { hoja: "WxYz", destino: "_gastos_pendientes" });
  assert.deepEqual(clasificarPeticionSheets(`${base}/values/'DATOS%20X'!W7?valueInputOption=RAW`), { hoja: "WxYz", destino: "DATOS X" });
  assert.deepEqual(clasificarPeticionSheets(`${base}/values/_cola!A1:append?valueInputOption=RAW`), { hoja: "WxYz", destino: "_cola" });
  assert.deepEqual(clasificarPeticionSheets(`${base}/values:batchGet?ranges=DATOS!A1:Z9&ranges=DATOS!X1:Z300&ranges=Otra!A1`), { hoja: "WxYz", destino: "batchGet[DATOS,Otra]" });
  assert.deepEqual(clasificarPeticionSheets(`${base}?fields=sheets.properties`), { hoja: "WxYz", destino: "metadatos" });
  assert.deepEqual(clasificarPeticionSheets(`${base}:batchUpdate`), { hoja: "WxYz", destino: "batchUpdate" });
  assert.deepEqual(clasificarPeticionSheets("no es una url"), { hoja: "?", destino: "?" });
});

test("origenDesdePila: primer módulo del proyecto, ignorando la capa de transporte de Sheets", () => {
  const pila = [
    "Error",
    "    at anotarUsoSheets (/app/dist/core/google/limitadorSheets.js:120:25)",
    "    at async Gaxios._request (/app/node_modules/gaxios/build/src/gaxios.js:150:20)",
    "    at async leerSheetsConReintento (/app/dist/core/google/sheetsReadRetry.js:10:20)",
    "    at async leerTodas (/app/dist/core/gastos/gastoProposalSheet.js:454:18)",
    "    at async handleGastoAprobarCallback (/app/dist/core/gastos/gastoCallbackHandler.js:2790:22)",
  ].join("\n");
  assert.equal(origenDesdePila(pila), "core/gastos/gastoProposalSheet");
  assert.equal(origenDesdePila("Error\n    at node:internal/process"), "(sin origen)");
});

test("usoSheetsReciente arranca vacío y devuelve la forma esperada", () => {
  const uso = usoSheetsReciente(Date.now());
  assert.equal(typeof uso.total, "number");
  assert.deepEqual(Object.keys(uso.porTipo).sort(), ["escritura", "lectura"]);
  assert.ok(Array.isArray(uso.mayores));
});

test("el adaptador anota cada petición a Sheets (tipo, prioridad y pestaña) y no las de otras APIs", async () => {
  const antes = usoSheetsReciente().total;
  const adaptador = crearAdaptadorSheetsConCuota({
    limitadores: { lectura: new LimitadorVentana(50, 0), escritura: new LimitadorVentana(50, 0) },
    esperar: async () => undefined,
  });
  const ok = async () => ({ status: 200 });
  await conPrioridadSheets("fondo", () => adaptador({ url: "https://sheets.googleapis.com/v4/spreadsheets/IDPRUEBA1234/values/_pestana_de_prueba!A1:B2" }, ok));
  await adaptador({ url: "https://www.googleapis.com/drive/v3/files" }, ok);
  const uso = usoSheetsReciente();
  assert.equal(uso.total, antes + 1, "solo cuenta la de Sheets");
  const fila = uso.mayores.find((f) => f.destino === "_pestana_de_prueba");
  assert.ok(fila);
  assert.equal(fila.tipo, "lectura");
  assert.equal(fila.prioridad, "fondo");
  assert.equal(fila.hoja, "1234");
});

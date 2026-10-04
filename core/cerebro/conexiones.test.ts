import assert from "node:assert/strict";
import test from "node:test";
import { evaluarEstadoWebhookTelegram, verificarSheetsParaPanel } from "./conexiones";
import { conPrioridadSheets, crearAdaptadorSheetsConCuota, type LimitadorVentana } from "../google/limitadorSheets";

const AHORA = Date.parse("2026-09-12T18:00:00.000Z");

test("falla si no existe webhook", () => {
  const estado = evaluarEstadoWebhookTelegram({ url: "", pendingUpdateCount: 0 }, AHORA);
  assert.equal(estado.ok, false);
});

test("mantiene visible un error reciente aunque Telegram ya no tenga cola", () => {
  const estado = evaluarEstadoWebhookTelegram({
    url: "https://example.invalid/webhook",
    pendingUpdateCount: 0,
    lastErrorMessage: "503 Service Unavailable",
    lastErrorDate: (AHORA - 5 * 60 * 1000) / 1000,
  }, AHORA);
  assert.equal(estado.ok, false);
});

test("una cola pendiente mantiene accionable incluso un error anterior", () => {
  const estado = evaluarEstadoWebhookTelegram({
    url: "https://example.invalid/webhook",
    pendingUpdateCount: 2,
    lastErrorMessage: "503 Service Unavailable",
    lastErrorDate: (AHORA - 60 * 60 * 1000) / 1000,
  }, AHORA);
  assert.equal(estado.ok, false);
  assert.match(estado.detalle ?? "", /2 actualización/);
});

test("no declara Telegram caído para siempre por un error histórico ya drenado", () => {
  const estado = evaluarEstadoWebhookTelegram({
    url: "https://example.invalid/webhook",
    pendingUpdateCount: 0,
    lastErrorMessage: "503 Service Unavailable",
    lastErrorDate: (AHORA - 24 * 60 * 60 * 1000) / 1000,
  }, AHORA);
  assert.equal(estado.ok, true);
  assert.match(estado.detalle ?? "", /resuelto/);
});

test("un webhook configurado y sin errores está sano", () => {
  const estado = evaluarEstadoWebhookTelegram({
    url: "https://example.invalid/webhook",
    pendingUpdateCount: 0,
  }, AHORA);
  assert.deepEqual(estado, { ok: true });
});


test("la sonda de Sheets usa la reserva interactiva aunque el panel se refresque en fondo", async () => {
  const prioridades: string[] = [];
  const limitador = { adquirir: async (prioridad: string) => { prioridades.push(prioridad); } } as unknown as LimitadorVentana;
  const adaptador = crearAdaptadorSheetsConCuota({ limitadores: { lectura: limitador, escritura: limitador } });
  const comprobar = async () => {
    await adaptador({ url: "https://sheets.googleapis.com/v4/spreadsheets/test" }, async () => ({ status: 200 }));
    return { ok: true };
  };
  const resultado = await conPrioridadSheets("fondo", () => verificarSheetsParaPanel(comprobar));
  assert.deepEqual(resultado, { ok: true });
  assert.deepEqual(prioridades, ["interactiva"]);
});

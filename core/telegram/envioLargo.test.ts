import assert from "node:assert/strict";
import test from "node:test";
import { editTelegramMessage, sendTelegramMessage, sendTelegramMessageSmart } from "./client";

process.env.TELEGRAM_BOT_TOKEN ??= "token-de-prueba";
// El espejo de botones y el historial escriben en Google Sheets con estas credenciales. Un JSON inválido hace que
// esas escrituras (best-effort) fallen al instante y en silencio, sin red: estas pruebas nunca pueden tocar una hoja
// real, ni siquiera ejecutadas con las variables de producción cargadas o con un archivo de credenciales por defecto.
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = "no-es-json";

interface Llamada { metodo: string; cuerpo: any }

/** Sustituye fetch por un doble que solo registra las peticiones: nada sale a la red. */
async function conTelegramSimulado<T>(prueba: (llamadas: Llamada[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const llamadas: Llamada[] = [];
  let siguienteId = 100;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const metodo = String(url).split("/").pop() ?? "";
    llamadas.push({ metodo, cuerpo: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: ++siguienteId } }), { status: 200 });
  }) as typeof fetch;
  try {
    return await prueba(llamadas);
  } finally {
    globalThis.fetch = original;
  }
}

const informeLargo = Array.from({ length: 90 }, (_, i) => `• Footprint · Proveedor ${i} · ${(7 + i / 7).toFixed(2)} EUR · compra 6aba27f01b0791ea0a0827${i}.`).join("\n");

test("un informe de más de 4096 caracteres sale en varios mensajes colapsables, cada uno dentro del límite", async (t) => {
  t.mock.method(console, "error", () => {});
  assert.ok(informeLargo.length > 4096);
  await conTelegramSimulado(async (llamadas) => {
    const ultimo = await sendTelegramMessageSmart(7, informeLargo);
    const envios = llamadas.filter((l) => l.metodo === "sendMessage");
    assert.ok(envios.length >= 2, "se parte en varios mensajes");
    for (const e of envios) assert.ok(e.cuerpo.text.length <= 4096, `mensaje de ${e.cuerpo.text.length} caracteres`);
    assert.match(envios[0].cuerpo.text, new RegExp(`\\(1/${envios.length}\\)`));
    assert.match(envios[envios.length - 1].cuerpo.text, new RegExp(`\\(${envios.length}/${envios.length}\\)`));
    assert.equal(ultimo, 100 + envios.length, "devuelve el id del último mensaje");
  });
});

test("los botones van solo en el último trozo", async (t) => {
  t.mock.method(console, "error", () => {});
  await conTelegramSimulado(async (llamadas) => {
    await sendTelegramMessageSmart(7, informeLargo, [[{ text: "OK", callback_data: "ok" }]]);
    const envios = llamadas.filter((l) => l.metodo === "sendMessage");
    assert.ok(envios.length >= 2);
    envios.forEach((e, i) => assert.equal(Boolean(e.cuerpo.reply_markup), i === envios.length - 1));
  });
});

test("sendTelegramMessage también parte los textos largos", async (t) => {
  t.mock.method(console, "error", () => {});
  await conTelegramSimulado(async (llamadas) => {
    await sendTelegramMessage(7, informeLargo);
    const envios = llamadas.filter((l) => l.metodo === "sendMessage");
    assert.ok(envios.length >= 2);
    for (const e of envios) assert.ok(e.cuerpo.text.length <= 4096);
  });
});

test("un texto corto sigue saliendo en un solo mensaje, como antes", async (t) => {
  t.mock.method(console, "error", () => {});
  await conTelegramSimulado(async (llamadas) => {
    await sendTelegramMessageSmart(7, "Ok, listo.");
    await sendTelegramMessage(7, "Otro aviso corto");
    assert.equal(llamadas.filter((l) => l.metodo === "sendMessage").length, 2);
  });
});

test("editar un mensaje con texto largo conserva el primer trozo y los botones en el original y manda el resto aparte", async (t) => {
  t.mock.method(console, "error", () => {});
  await conTelegramSimulado(async (llamadas) => {
    await editTelegramMessage(7, 55, informeLargo, [[{ text: "OK", callback_data: "ok" }]]);
    const edicion = llamadas.filter((l) => l.metodo === "editMessageText");
    const resto = llamadas.filter((l) => l.metodo === "sendMessage");
    assert.equal(edicion.length, 1);
    assert.ok(edicion[0].cuerpo.text.length <= 4096);
    assert.ok(edicion[0].cuerpo.reply_markup, "los botones se quedan en el mensaje editado");
    assert.ok(resto.length >= 1);
    for (const r of resto) assert.ok(r.cuerpo.text.length <= 4096);
  });
});

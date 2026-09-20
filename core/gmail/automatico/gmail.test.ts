import assert from "node:assert/strict";
import test from "node:test";
import type { gmail_v1 } from "googleapis";
import { contenidoCompleto, GmailAuto } from "./gmail";
import { correoFixture } from "./fixtures";
const b64 = (s: string) => Buffer.from(s).toString("base64url");

test("lee todas las partes textuales, incluido cuerpo servido como attachmentId", async () => {
  const gmail = { users: { messages: { attachments: { get: async () => ({ data: { data: b64("Final importante") } }) } } } } as unknown as gmail_v1.Gmail;
  const r = await contenidoCompleto(gmail, { id: "m", payload: { parts: [
    { mimeType: "text/plain", body: { data: b64("Inicio ".repeat(2000)) } },
    { mimeType: "text/plain", body: { attachmentId: "texto", size: 20 } },
    { partId: "img", mimeType: "image/png", body: { data: b64("recibo inline pequeño"), size: 20 } },
  ] } });
  assert.ok(r.cuerpo.length > 8000); assert.ok(r.cuerpo.endsWith("Final importante"));
  assert.equal(r.adjuntos.length, 1); assert.equal(r.adjuntos[0].id, "img");
});
test("paginación completa, todos los mensajes pendientes no leídos y archivados incluidos", async () => {
  const consultas: Record<string, unknown>[] = [];
  const gmail = { users: { labels: { list: async () => ({ data: { labels: [] } }) }, threads: {
    list: async (q: Record<string, unknown>) => { consultas.push(q); return { data: q.pageToken ? { threads: [{ id: "t2" }] } : { threads: [{ id: "t1" }], nextPageToken: "next" } }; },
    get: async ({ id }: { id: string }) => ({ data: { messages: [1, 2].map(n => ({ id: `${id}-${n}`, labelIds: ["UNREAD"], internalDate: String(n),
      payload: { mimeType: "text/plain", body: { data: b64(`mensaje ${n}`) } } })) } }),
  } } } as unknown as gmail_v1.Gmail;
  const r = await new GmailAuto(gmail, gmail).listar();
  assert.equal(r.length, 4); assert.equal(consultas.length, 2);
  assert.equal(consultas[0].q, "is:unread -label:WOBI_AUTO_PROCESADO -in:spam -in:trash");
});
test("un mensaje automático ya etiquetado no reaparece si llega otro mensaje al mismo hilo", async () => {
  const gmail = { users: {
    labels: { list: async () => ({ data: { labels: [{ id: "label-auto", name: "WOBI_AUTO_PROCESADO" }] } }) },
    threads: {
      list: async () => ({ data: { threads: [{ id: "t1" }] } }),
      get: async () => ({ data: { messages: [
        { id: "anterior", labelIds: ["UNREAD", "label-auto"], internalDate: "1",
          payload: { mimeType: "text/plain", body: { data: b64("ya procesado") } } },
        { id: "nuevo", labelIds: ["UNREAD"], internalDate: "2",
          payload: { mimeType: "text/plain", body: { data: b64("nuevo mensaje") } } },
      ] } }),
    },
  } } as unknown as gmail_v1.Gmail;
  const r = await new GmailAuto(gmail, gmail).listar();
  assert.deepEqual(r.map(c => c.id), ["nuevo"]);
});
test("marca leído el mensaje procesado, lo etiqueta y nunca toca todo el hilo", async () => {
  const modificados: Array<{ id: string; agregar: string[]; quitar: string[] }> = [];
  const gmail = { users: {
    labels: { list: async () => ({ data: { labels: [{ id: "label-auto", name: "WOBI_AUTO_PROCESADO" }] } }) },
    messages: {
      modify: async ({ id, requestBody }: { id: string; requestBody: { addLabelIds: string[]; removeLabelIds: string[] } }) => {
        modificados.push({ id, agregar: requestBody.addLabelIds, quitar: requestBody.removeLabelIds }); return { data: {} };
      },
      get: async ({ id }: { id: string }) => ({ data: { id, labelIds: ["label-auto"] } }),
    },
  } } as unknown as gmail_v1.Gmail;
  await new GmailAuto(gmail, gmail).marcarResuelto(correoFixture());
  assert.deepEqual(modificados, [{ id: "m1", agregar: ["label-auto"], quitar: ["UNREAD"] }]);
});
test("recupera por id un mensaje ya leído para terminar una operación durable", async () => {
  const gmail = { users: { threads: {
    get: async () => ({ data: { messages: [{ id: "m-leido", labelIds: [], internalDate: "1",
      payload: { mimeType: "text/plain", body: { data: b64("comprobante") } } }] } }),
  } } } as unknown as gmail_v1.Gmail;
  const correo = await new GmailAuto(gmail, gmail).obtener("m-leido", "t1");
  assert.equal(correo?.id, "m-leido");
  assert.equal(correo?.cuerpo.includes("comprobante"), true);
});
test("un fallo de descarga deja evidencia incompleta, no un correo vacío procesable", async () => {
  const gmail = { users: { labels: { list: async () => ({ data: { labels: [] } }) }, threads: {
    list: async () => ({ data: { threads: [{ id: "t" }] } }),
    get: async () => ({ data: { messages: [{ id: "m", labelIds: ["UNREAD"], internalDate: "1",
      payload: { mimeType: "text/plain", body: { size: 10 } } }] } }),
  } } } as unknown as gmail_v1.Gmail;
  const r = await new GmailAuto(gmail, gmail).listar();
  assert.match(r[0].lecturaError ?? "", /vacía inesperadamente/);
});
test("descarga hilos con concurrencia acotada, conserva orden e informa progreso", async () => {
  let activas = 0, maximas = 0;
  const progreso: number[] = [];
  const gmail = { users: { labels: { list: async () => ({ data: { labels: [] } }) }, threads: {
    list: async () => ({ data: { threads: ["t1", "t2", "t3", "t4"].map(id => ({ id })) } }),
    get: async ({ id }: { id: string }) => {
      activas++; maximas = Math.max(maximas, activas);
      await new Promise(resolve => setTimeout(resolve, id === "t1" ? 8 : 1));
      activas--;
      return { data: { messages: [{ id: `m-${id}`, labelIds: ["UNREAD"], internalDate: id.slice(1),
        payload: { mimeType: "text/plain", body: { data: b64(id) } } }] } };
    },
  } } } as unknown as gmail_v1.Gmail;
  const r = await new GmailAuto(gmail, gmail, { concurrencia: 2, progreso: n => { progreso.push(n); } }).listar();
  assert.deepEqual(r.map(c => c.threadId), ["t1", "t2", "t3", "t4"]);
  assert.equal(maximas, 2);
  assert.equal(progreso[0], 0);
  assert.equal(progreso.at(-1), 4);
});

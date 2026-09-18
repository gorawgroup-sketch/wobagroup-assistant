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
test("paginación completa, todos los mensajes no leídos y archivados incluidos", async () => {
  const consultas: Record<string, unknown>[] = [];
  const gmail = { users: { threads: {
    list: async (q: Record<string, unknown>) => { consultas.push(q); return { data: q.pageToken ? { threads: [{ id: "t2" }] } : { threads: [{ id: "t1" }], nextPageToken: "next" } }; },
    get: async ({ id }: { id: string }) => ({ data: { messages: [1, 2].map(n => ({ id: `${id}-${n}`, labelIds: ["UNREAD"], internalDate: String(n),
      payload: { mimeType: "text/plain", body: { data: b64(`mensaje ${n}`) } } })) } }),
  } } } as unknown as gmail_v1.Gmail;
  const r = await new GmailAuto(gmail, gmail).listar();
  assert.equal(r.length, 4); assert.equal(consultas.length, 2);
  assert.equal(consultas[0].q, "is:unread -in:spam -in:trash");
});
test("solo marca el mensaje procesado, nunca el hilo que recibió una respuesta nueva", async () => {
  const modificados: string[] = [];
  const gmail = { users: { messages: {
    modify: async ({ id }: { id: string }) => { modificados.push(id); return { data: {} }; },
    get: async ({ id }: { id: string }) => ({ data: { id, labelIds: [] } }),
  } } } as unknown as gmail_v1.Gmail;
  await new GmailAuto(gmail, gmail).marcarResuelto(correoFixture());
  assert.deepEqual(modificados, ["m1"]);
});
test("un fallo de descarga deja evidencia incompleta, no un correo vacío procesable", async () => {
  const gmail = { users: { threads: {
    list: async () => ({ data: { threads: [{ id: "t" }] } }),
    get: async () => ({ data: { messages: [{ id: "m", labelIds: ["UNREAD"], internalDate: "1",
      payload: { mimeType: "text/plain", body: { size: 10 } } }] } }),
  } } } as unknown as gmail_v1.Gmail;
  const r = await new GmailAuto(gmail, gmail).listar();
  assert.match(r[0].lecturaError ?? "", /vacía inesperadamente/);
});

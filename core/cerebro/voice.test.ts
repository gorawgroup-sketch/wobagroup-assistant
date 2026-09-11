import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { once } from "node:events";
import { crearRouterVoz } from "./voiceRouter";
import { textoParaVoz, WOBI_VOICE } from "./voice";

test("voice pronunciation preserves displayed brand separately and escapes SSML", () => {
  assert.equal(WOBI_VOICE, "es-MX-DaliaNeural");
  assert.equal(textoParaVoz('Soy WOBi. <voice name="otro">A & B</voice>'),
    'Soy Uóbi. &lt;voice name=&quot;otro&quot;&gt;A &amp; B&lt;/voice&gt;');
});

test("voice endpoint authorizes, validates, uses the fixed voice and does not cache", async () => {
  const calls: string[] = [];
  const app = express();
  app.use(express.json());
  app.use("/voice", crearRouterVoz(async (req, res) => {
    if (req.get("X-Cerebro-Key") === "test-session") return true;
    res.sendStatus(403); return false;
  }, async text => { calls.push(text); return Buffer.from("test audio"); }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const send = (body: unknown, authorized = true) => fetch(`http://127.0.0.1:${address.port}/voice`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(authorized ? { "X-Cerebro-Key": "test-session" } : {}) },
    body: JSON.stringify(body),
  });
  try {
    assert.equal((await send({ texto: "Hola" }, false)).status, 403);
    for (const texto of ["", " ", 42, "a".repeat(501)]) assert.equal((await send({ texto })).status, 400);
    assert.deepEqual(calls, []);
    const result = await send({ texto: "Soy Wobi", voice: "otra" });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("X-Wobi-Voice"), WOBI_VOICE);
    assert.equal(result.headers.get("Cache-Control"), "no-store");
    assert.match(result.headers.get("Content-Type") || "", /audio\/mpeg/);
    assert.equal(await result.text(), "test audio");
    assert.deepEqual(calls, ["Soy Wobi"]);
  } finally { server.closeAllConnections(); server.close(); }
});

test("voice timeout releases capacity and does not expose provider errors", async () => {
  let calls = 0;
  const app = express(); app.use(express.json());
  app.use("/voice", crearRouterVoz(async () => true, async (_text, signal) => {
    if (++calls > 1) return Buffer.from("recovered");
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("private provider detail")), { once: true }));
  }, 30));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const send = () => fetch(`http://127.0.0.1:${address.port}/voice`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ texto: "Hola" }) });
  try {
    const result = await send(); assert.equal(result.status, 503);
    assert.doesNotMatch(await result.text(), /private provider/);
    assert.equal((await send()).status, 200);
  } finally { server.closeAllConnections(); server.close(); }
});

import assert from "node:assert/strict";
import test from "node:test";
import { construirMimeConAdjuntos, configuracionEnviosCorreoDurables } from "./client";

test("el MIME lleva el Message-ID durable y conserva las cabeceras de respuesta", () => {
  const mime = construirMimeConAdjuntos({
    to: "destino@example.com",
    asunto: "Prueba",
    cuerpo: "Contenido",
    messageIdPropio: "<wobi-id@idempotency.wobagroup.com>",
    messageIdHeader: "<mensaje-original@example.com>",
  }).toString("utf8");
  assert.match(mime, /Message-ID: <wobi-id@idempotency\.wobagroup\.com>\r\n/);
  assert.match(mime, /In-Reply-To: <mensaje-original@example\.com>\r\n/);
  assert.match(mime, /References: <mensaje-original@example\.com>\r\n/);
  assert.match(mime, /Subject: Re: Prueba\r\n/);
});

test("el interruptor solo desactiva el ledger con false explícito", () => {
  assert.equal(configuracionEnviosCorreoDurables({}).habilitado, true);
  assert.equal(configuracionEnviosCorreoDurables({ WOBI_EMAIL_DURABLE_ENABLED: "errata" }).habilitado, true);
  assert.equal(configuracionEnviosCorreoDurables({ WOBI_EMAIL_DURABLE_ENABLED: "false" }).habilitado, false);
});

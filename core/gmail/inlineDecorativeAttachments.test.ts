import assert from "node:assert/strict";
import test from "node:test";
import type { gmail_v1 } from "googleapis";
import { esHuellaInlineDecorativaConocida } from "./client";

function parte(overrides: Partial<gmail_v1.Schema$MessagePart> = {}): gmail_v1.Schema$MessagePart {
  return {
    filename: "image.png",
    mimeType: "image/png",
    body: { size: 51_837, attachmentId: "banner" },
    headers: [
      { name: "Content-Disposition", value: 'inline; filename="image.png"' },
      { name: "Content-ID", value: "<banner@example>" },
    ],
    ...overrides,
  };
}

test("reconoce la firma inline auditada que generaba una segunda propuesta", () => {
  assert.equal(esHuellaInlineDecorativaConocida(parte()), true);
});

test("nunca excluye un comprobante real enviado como attachment aunque coincida el tamaño", () => {
  assert.equal(
    esHuellaInlineDecorativaConocida(
      parte({
        headers: [
          { name: "Content-Disposition", value: 'attachment; filename="image.png"' },
          { name: "Content-ID", value: "<receipt@example>" },
        ],
      })
    ),
    false
  );
});

test("la excepción es fail-open ante cualquier cambio de la firma", () => {
  assert.equal(esHuellaInlineDecorativaConocida(parte({ body: { size: 51_838, attachmentId: "banner" } })), false);
  assert.equal(esHuellaInlineDecorativaConocida(parte({ filename: "recibo.png" })), false);
  assert.equal(
    esHuellaInlineDecorativaConocida(
      parte({ headers: [{ name: "Content-Disposition", value: 'inline; filename="image.png"' }] })
    ),
    false
  );
});

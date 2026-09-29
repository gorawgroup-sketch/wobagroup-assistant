import assert from "node:assert/strict";
import test from "node:test";
import type { gmail_v1 } from "googleapis";
import { esHuellaInlineDecorativaConocida, extraerAdjuntos } from "./client";

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

test("un PDF adjuntado como inline es un comprobante real aunque pese poco (caso Yessenia, 17,96 € uber.pdf)", () => {
  const adjuntos = extraerAdjuntos({
    mimeType: "multipart/mixed",
    parts: [
      { partId: "0", mimeType: "application/pdf", filename: "17,96€ uber.pdf", body: { size: 19_842, attachmentId: "pdf" },
        headers: [{ name: "Content-Disposition", value: 'inline; filename="17,96€ uber.pdf"' }] },
      { partId: "1", mimeType: "text/plain", filename: "", body: { size: 2 } },
    ],
  });
  assert.deepEqual(adjuntos.map((a) => a.filename), ["17,96€ uber.pdf"]);
});

test("una imagen inline pequeña sin Content-ID no está incrustada: se procesa como adjunto", () => {
  const adjuntos = extraerAdjuntos({ parts: [parte({ filename: "ticket.jpg", mimeType: "image/jpeg", body: { size: 12_000, attachmentId: "t" },
    headers: [{ name: "Content-Disposition", value: 'inline; filename="ticket.jpg"' }] })] });
  assert.equal(adjuntos.length, 1);
});

test("el logo pequeño incrustado con Content-ID sigue excluido", () => {
  const adjuntos = extraerAdjuntos({ parts: [parte({ filename: "noname", body: { size: 2_969, attachmentId: "logo" },
    headers: [{ name: "Content-Disposition", value: "inline" }, { name: "Content-ID", value: "<logo@x>" }] }), parte()] });
  assert.equal(adjuntos.length, 0);
});

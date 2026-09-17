import assert from "node:assert/strict";
import test from "node:test";
import { seleccionarAttachmentIdActual } from "./reDescargarAdjunto";

test("recupera el attachmentId vigente usando el partId estable", () => {
  const actual = seleccionarAttachmentIdActual(
    [
      { partId: "1", attachmentId: "nuevo-1" },
      { partId: "2", attachmentId: "nuevo-2" },
    ],
    "2"
  );
  assert.equal(actual, "nuevo-2");
});

test("falla cerrado si el partId falta o aparece duplicado", () => {
  assert.equal(seleccionarAttachmentIdActual([{ partId: "1", attachmentId: "a" }], "2"), undefined);
  assert.equal(
    seleccionarAttachmentIdActual(
      [
        { partId: "1", attachmentId: "a" },
        { partId: "1", attachmentId: "b" },
      ],
      "1"
    ),
    undefined
  );
});

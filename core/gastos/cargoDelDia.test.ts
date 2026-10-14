import assert from "node:assert/strict";
import test from "node:test";
import { preferirAproximadoDelDia } from "./cargoDelDia";

test("exacto lejano frente a aproximado del mismo día: gana el del día (Anthropic 13/10)", () => {
  const exactos = [{ fecha: "2026-10-08", monto: -21.63 }];
  const aproximados = [{ fecha: "2026-10-13", monto: -21.61 }, { fecha: "2026-10-05", monto: -21.58 }];
  assert.equal(preferirAproximadoDelDia(exactos, aproximados, "2026-10-13")?.fecha, "2026-10-13");
});

test("si algún exacto está cerca, o no hay aproximado del día, no se cambia nada", () => {
  assert.equal(preferirAproximadoDelDia([{ fecha: "2026-10-12" }], [{ fecha: "2026-10-13" }], "2026-10-13"), undefined);
  assert.equal(preferirAproximadoDelDia([{ fecha: "2026-10-08" }], [{ fecha: "2026-10-10" }], "2026-10-13"), undefined);
  assert.equal(preferirAproximadoDelDia([], [{ fecha: "2026-10-13" }], "2026-10-13"), undefined);
});

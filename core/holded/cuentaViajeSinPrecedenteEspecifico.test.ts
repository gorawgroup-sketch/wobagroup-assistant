import assert from "node:assert/strict";
import test from "node:test";
import { sugerirCuentaPorViaje } from "./write";

const linea = (documentId: string, account: string, tags: string[]) =>
  ({ documentId, contactName: "Uber", descripcion: "Traslado", lineName: "Traslado", account, tags });
const historicos = Array.from({ length: 5 }, (_, i) => linea(`h${i}`, "viajes", ["transporte", "uber", "kelly"]));

test("un taxi sin precedentes etiquetados «taxi» usa la cuenta de los precedentes de viaje", () => {
  const r = sugerirCuentaPorViaje([...historicos, linea("t1", "viajes", ["taxi", "transporte"])], ["transporte", "taxi"]);
  assert.equal(r?.accountId, "viajes");
  assert.equal(r?.aprendidoDe, "viaje");
});

test("con evidencia suficiente de la misma naturaleza, esa evidencia manda", () => {
  const taxis = Array.from({ length: 3 }, (_, i) => linea(`t${i}`, "taxis", ["taxi", "transporte"]));
  assert.equal(sugerirCuentaPorViaje([...historicos, ...taxis], ["transporte", "taxi"])?.accountId, "taxis");
});

test("sin precedentes de viaje suficientes no inventa una cuenta", () => {
  assert.equal(sugerirCuentaPorViaje([linea("a", "viajes", ["transporte"])], ["transporte", "taxi"]), undefined);
});

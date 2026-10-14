import assert from "node:assert/strict";
import test from "node:test";
import { esCopiaPendienteDeConciliado, firmasConciliadas } from "./duplicadosBancarios";

// Caso real 14-10-2026 (WOBA Main): Anthropic −21,63 del 08/10 duplicado (una conciliada, una pendiente).
test("la copia pendiente de un cargo ya conciliado se reconoce; un cargo distinto del mismo proveedor no", () => {
  const lista = [
    { description: "Anthropic", amount: "-21.63", booking_date: "2026-10-08T00:00:00+00:00", status: "reconciled" },
    { description: "Anthropic", amount: "-21.63", booking_date: "2026-10-08T00:00:00+00:00", status: "pending" },
    { description: "Anthropic", amount: "-21.61", booking_date: "2026-10-13T00:00:00+00:00", status: "pending" },
  ];
  const firmas = firmasConciliadas(lista);
  assert.equal(esCopiaPendienteDeConciliado(lista[1], firmas), true);
  assert.equal(esCopiaPendienteDeConciliado(lista[2], firmas), false, "el cargo real del 13/10 sigue siendo candidato");
  assert.equal(esCopiaPendienteDeConciliado(lista[0], firmas), false, "el conciliado no es «copia»");
});

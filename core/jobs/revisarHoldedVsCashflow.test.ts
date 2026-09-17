import test from "node:test";
import assert from "node:assert/strict";
import { buscarPosibleDuplicado } from "./revisarHoldedVsCashflow";

test("detecta un posible duplicado en una categoría sin columna EMPRESA", () => {
  const duplicado = buscarPosibleDuplicado(
    "BANAHOSTING.COM",
    "WOBA",
    208.73,
    [{ concepto: "Banahosting", semana: "S37", valor: "204,68 €" }],
    []
  );

  assert.ok(duplicado);
  assert.equal(duplicado.montoRegistrado, 204.68);
});

test("la revalidación final también bloquea un importe exacto", () => {
  const registros = [{ concepto: "Anthropic", semana: "S37", valor: "17,34 €" }];

  assert.equal(buscarPosibleDuplicado("Anthropic", "WOBA", 17.34, registros, []), undefined);
  assert.ok(buscarPosibleDuplicado("Anthropic", "WOBA", 17.34, registros, [], true));
});

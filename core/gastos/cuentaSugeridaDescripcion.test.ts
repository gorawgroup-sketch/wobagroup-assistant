import assert from "node:assert/strict";
import test from "node:test";
import { describirCuentaSugerida } from "./procesarGastoEntrante";

test("un gasto de viaje nunca se presenta como vinculado a un precedente de otra persona o ubicación", () => {
  const texto = describirCuentaSugerida({
    accountId: "gastos-viaje",
    tags: ["taxi", "transporte"],
    ejemplo: "Uber Bogotá — Alejandro Florez",
    aprendidoDe: "proveedor",
    evidencias: 8,
  }, ["transporte", "taxi"]);

  assert.match(texto, /8 documentos independientes/);
  assert.match(texto, /no está vinculada a un gasto individual/);
  assert.match(texto, /No se usa ni se muestra otro viaje/);
  assert.doesNotMatch(texto, /Bogotá|Alejandro/);
});

test("solo muestra una referencia de viaje cuando comparte contexto comprobado", () => {
  const texto = describirCuentaSugerida({
    accountId: "gastos-viaje",
    tags: ["taxi", "transporte"],
    ejemplo: "Bolt Barcelona — Nuria Ortiz",
    aprendidoDe: "viaje",
    evidencias: 5,
    contextoEjemplo: ["persona", "ubicacion"],
  }, ["transporte", "taxi"]);

  assert.match(texto, /misma persona y ubicación/);
  assert.match(texto, /Bolt Barcelona — Nuria Ortiz/);
});

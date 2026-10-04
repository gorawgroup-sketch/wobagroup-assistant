import assert from "node:assert/strict";
import test from "node:test";
import { matchProject, type HoldedProject } from "./client";

const projects: HoldedProject[] = [
  { id: "p-1", name: "SINFONÍA MIAMI", archived: false },
  { id: "p-2", name: "Footprint Internal", archived: false },
  { id: "p-3", name: "Proyecto duplicado", archived: false },
  { id: "p-4", name: "Proyecto duplicado", archived: false },
  { id: "p-5", name: "Antiguo", archived: true },
];

test("matchProject acepta un id único", () => {
  assert.equal(matchProject(projects, "p-2").exact?.id, "p-2");
});

test("matchProject normaliza mayúsculas y acentos para un nombre exacto", () => {
  assert.equal(matchProject(projects, "sinfonia miami").exact?.id, "p-1");
});

test("matchProject nunca convierte una coincidencia parcial en exacta", () => {
  const match = matchProject(projects, "Footprint");
  assert.equal(match.exact, undefined);
  assert.deepEqual(match.candidates.map((project) => project.id), ["p-2"]);
});

test("matchProject mantiene ambiguos los nombres duplicados", () => {
  const match = matchProject(projects, "Proyecto duplicado");
  assert.equal(match.exact, undefined);
  assert.deepEqual(match.candidates.map((project) => project.id), ["p-3", "p-4"]);
});

test("matchProject excluye archivados salvo autorización explícita", () => {
  assert.equal(matchProject(projects, "Antiguo").exact, undefined);
  assert.equal(matchProject(projects, "Antiguo", true).exact?.id, "p-5");
});

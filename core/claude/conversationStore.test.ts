import assert from "node:assert/strict";
import test from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { recortarHistorialParaGuardar } from "./conversationStore";

function turnoSimple(texto: string): Anthropic.MessageParam[] {
  return [
    { role: "user", content: texto },
    { role: "assistant", content: `respuesta a: ${texto}` },
  ];
}

test("no recorta un historial corto y liviano", () => {
  const historial = [...turnoSimple("hola"), ...turnoSimple("como estas")];
  assert.deepEqual(recortarHistorialParaGuardar(historial), historial);
});

test("recorta por cantidad respetando el inicio de turno (MAX_MESSAGES=30)", () => {
  const turnos = Array.from({ length: 20 }, (_, i) => turnoSimple(`mensaje ${i}`)).flat();
  const recortado = recortarHistorialParaGuardar(turnos);
  assert.ok(recortado.length <= 30);
  assert.equal(recortado[0].role, "user");
  assert.equal(typeof recortado[0].content, "string");
});

test("caso real de auditoría (2026-09-15): un historial con un bloque grande (ej. firma de razonamiento extendido) que supera 50.000 caracteres en una celda se recorta por tamaño, no solo por cantidad", () => {
  const bloqueGrande = "x".repeat(60_000);
  const historial: Anthropic.MessageParam[] = [
    { role: "user", content: "primer turno" },
    { role: "assistant", content: bloqueGrande },
    { role: "user", content: "segundo turno, el que importa recordar" },
    { role: "assistant", content: "respuesta corta" },
  ];
  const recortado = recortarHistorialParaGuardar(historial);
  assert.ok(JSON.stringify(recortado).length <= 45_000);
  // El turno más reciente (el que el usuario acaba de ver) se conserva — es
  // exactamente lo que antes se perdía y motivó este fix.
  assert.deepEqual(recortado, [
    { role: "user", content: "segundo turno, el que importa recordar" },
    { role: "assistant", content: "respuesta corta" },
  ]);
});

test("si ni siquiera el turno más reciente entra en el límite de tamaño, se guarda vacío en vez de fallar la escritura completa", () => {
  const historial: Anthropic.MessageParam[] = [
    { role: "user", content: "unico turno" },
    { role: "assistant", content: "x".repeat(60_000) },
  ];
  const recortado = recortarHistorialParaGuardar(historial);
  assert.deepEqual(recortado, []);
});

test("nunca deja un tool_result huérfano al recortar por tamaño", () => {
  const historial: Anthropic.MessageParam[] = [
    { role: "user", content: "turno viejo con mucho contenido".repeat(2000) },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "buscar", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "resultado" }] },
    { role: "assistant", content: "cierre del turno viejo" },
    { role: "user", content: "turno nuevo" },
    { role: "assistant", content: "respuesta nueva" },
  ];
  const recortado = recortarHistorialParaGuardar(historial);
  if (recortado.length > 0) {
    assert.equal(recortado[0].role, "user");
    assert.equal(typeof recortado[0].content, "string");
  }
});

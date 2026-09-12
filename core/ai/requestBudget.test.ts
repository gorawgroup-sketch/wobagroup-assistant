import assert from "node:assert/strict";
import test from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import {
  contarCaracteresEntradaIA,
  obtenerPresupuestoSolicitudIA,
  PresupuestoSolicitudIAExcedidoError,
  validarPresupuestoSolicitudIA,
} from "./requestBudget";

function solicitud(texto: string): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: "claude-sonnet-5",
    max_tokens: 100,
    system: "sistema estable",
    messages: [{ role: "user", content: texto }],
  };
}

test("aplica presupuestos más estrictos a clasificadores", () => {
  assert.deepEqual(obtenerPresupuestoSolicitudIA("clasificar_documento", {} as NodeJS.ProcessEnv), {
    maxLlamadasPorEjecucion: 6,
    maxCaracteresEntrada: 160_000,
  });
  assert.equal(
    obtenerPresupuestoSolicitudIA("chat_conversacional", {} as NodeJS.ProcessEnv).maxCaracteresEntrada,
    900_000
  );
});

test("permite ajustes acotados por proceso sin abrir límites absurdos", () => {
  const env = {
    WOBI_AI_MAX_CALLS_CLASIFICAR_DOCUMENTO: "2",
    WOBI_AI_MAX_INPUT_CHARS_CLASIFICAR_DOCUMENTO: "1000",
  } as NodeJS.ProcessEnv;
  const presupuesto = obtenerPresupuestoSolicitudIA("clasificar_documento", env);
  assert.equal(presupuesto.maxLlamadasPorEjecucion, 2);
  assert.equal(presupuesto.maxCaracteresEntrada, 20_000);
});

test("cuenta texto y herramientas pero no confunde un PDF base64 con texto", () => {
  const params = solicitud("hola") as Anthropic.MessageCreateParamsNonStreaming & { messages: unknown[] };
  params.messages = [
    {
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "x".repeat(50_000) } },
        { type: "text", text: "instrucción visible" },
      ],
    },
  ];
  const caracteres = contarCaracteresEntradaIA(params as Anthropic.MessageCreateParamsNonStreaming);
  assert.ok(caracteres < 1_000);
  assert.ok(caracteres >= "sistema estable".length + "instrucción visible".length);
});

test("un campo data ordinario continúa contando como contexto", () => {
  const params = solicitud("hola") as Anthropic.MessageCreateParamsNonStreaming & { tools: unknown[] };
  params.tools = [{
    name: "consultar",
    description: "consulta segura",
    input_schema: { type: "object", properties: { data: { const: "x".repeat(25_000) } } },
  }];
  assert.ok(contarCaracteresEntradaIA(params) > 25_000);
});

test("bloquea contexto excesivo antes de llamar al proveedor", () => {
  assert.throws(
    () =>
      validarPresupuestoSolicitudIA(
        "clasificar_documento",
        1,
        solicitud("x".repeat(25_000)),
        { WOBI_AI_MAX_INPUT_CHARS_CLASIFICAR_DOCUMENTO: "20000" } as NodeJS.ProcessEnv
      ),
    (error) => error instanceof PresupuestoSolicitudIAExcedidoError && error.tipo === "contexto"
  );
});

test("bloquea una vuelta adicional aunque el contexto sea pequeño", () => {
  assert.throws(
    () =>
      validarPresupuestoSolicitudIA(
        "clasificar_correo",
        5,
        solicitud("correo corto"),
        {} as NodeJS.ProcessEnv
      ),
    (error) => error instanceof PresupuestoSolicitudIAExcedidoError && error.tipo === "llamadas"
  );
});

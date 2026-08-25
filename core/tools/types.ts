import type Anthropic from "@anthropic-ai/sdk";

/** Contexto de la conversación en curso, disponible para los handlers que lo necesiten. */
export interface ToolContext {
  chatId?: number;
}

/**
 * Definición interna de una herramienta que Claude puede invocar (tool use).
 * `name`, `description` e `input_schema` se envían tal cual a la API de Anthropic;
 * `handler` es la función local que se ejecuta cuando Claude decide usar la herramienta.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
  handler: (input: Record<string, unknown>, context?: ToolContext) => Promise<string> | string;
}

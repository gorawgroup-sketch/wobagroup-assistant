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
  /**
   * true SOLO en herramientas de solo lectura, sin ningún efecto secundario
   * (ni siquiera crear una propuesta pendiente) — son las únicas que se le
   * dan al modelo económico (Haiku) en el primer intento de cada mensaje
   * (core/claude/client.ts). Por defecto (sin este campo, o en false) la
   * herramienta queda fuera de ese primer intento y solo la ve el modelo
   * principal (Sonnet) — es decir, una herramienta nueva es Sonnet-only
   * hasta que alguien decida explícitamente marcarla segura, nunca al revés.
   */
  seguraParaModoRapido?: boolean;
}

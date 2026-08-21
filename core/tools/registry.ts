import type Anthropic from "@anthropic-ai/sdk";
import type { ToolDefinition } from "./types";
import { knowledgeBaseTool } from "./knowledgeBase";
import { cashflowResumenTool } from "./cashflowResumen";
import { cashflowDetalleTool } from "./cashflowDetalle";

/**
 * Registro central de herramientas disponibles para Claude.
 * Cada nueva herramienta (holded, drive, gmail...) se agrega aquí.
 */
const tools: ToolDefinition[] = [knowledgeBaseTool, cashflowResumenTool, cashflowDetalleTool];

/**
 * Definiciones en el formato que espera el parámetro `tools` de la API de Anthropic.
 */
export function getToolDefinitions(): Anthropic.Tool[] {
  return tools.map(({ name, description, input_schema }) => ({
    name,
    description,
    input_schema,
  }));
}

/**
 * Ejecuta la herramienta solicitada por Claude y devuelve el resultado como texto,
 * listo para enviarse de vuelta como tool_result.
 */
export async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  const tool = tools.find((t) => t.name === name);

  if (!tool) {
    return `Error: la herramienta "${name}" no existe.`;
  }

  try {
    return await tool.handler(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error ejecutando la herramienta "${name}": ${message}`;
  }
}

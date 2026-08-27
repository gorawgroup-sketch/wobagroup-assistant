import type Anthropic from "@anthropic-ai/sdk";
import type { ToolContext, ToolDefinition } from "./types";
import { knowledgeBaseTool } from "./knowledgeBase";
import { cashflowResumenTool } from "./cashflowResumen";
import { cashflowDetalleTool } from "./cashflowDetalle";
import { holdedMovimientosTool } from "./holdedMovimientos";
import { driveSearchTool } from "./driveSearch";
import { driveListFoldersTool } from "./driveListFolders";
import { alertasFiscalesTool } from "./alertasFiscales";
import { proponerEnvioCorreoTool } from "./proposeEmail";
import { registrarCorreccionTool } from "./registerCorrection";
import { costosIATool } from "./costosIA";
import { gastosSinComprobanteTool } from "./gastosSinComprobante";
import { movimientosSinConciliarTool } from "./movimientosSinConciliar";
import { proponerEventoCalendarioTool } from "./proponerEvento";
import { verificarCashflowActualizadoTool } from "./verificarCashflowActualizado";

/**
 * Registro central de herramientas disponibles para Claude.
 * Cada nueva herramienta (gmail...) se agrega aquí.
 */
const tools: ToolDefinition[] = [
  knowledgeBaseTool,
  cashflowResumenTool,
  cashflowDetalleTool,
  holdedMovimientosTool,
  driveSearchTool,
  driveListFoldersTool,
  alertasFiscalesTool,
  proponerEnvioCorreoTool,
  registrarCorreccionTool,
  costosIATool,
  gastosSinComprobanteTool,
  movimientosSinConciliarTool,
  proponerEventoCalendarioTool,
  verificarCashflowActualizadoTool,
];

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
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolContext = {}
): Promise<string> {
  const tool = tools.find((t) => t.name === name);

  if (!tool) {
    return `Error: la herramienta "${name}" no existe.`;
  }

  try {
    return await tool.handler(input, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error ejecutando la herramienta "${name}": ${message}`;
  }
}

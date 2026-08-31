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
import { consultarEventosCalendarioTool } from "./consultarEventosCalendario";
import { verificarCashflowActualizadoTool } from "./verificarCashflowActualizado";
import { proponerRegistroCashflowTool } from "./proponerRegistroCashflow";
import { capturarCorreoTool } from "./capturarCorreo";
import { saldosBancariosTool } from "./saldosBancarios";
import { generarReporteContableTool } from "./generarReporteContable";
import { directorioPersonasTool } from "./directorioPersonas";
import { verificarGastosSinMovimientoBancarioTool } from "./verificarGastosSinMovimientoBancario";
import { verificarNumeracionCashflowTool } from "./verificarNumeracionCashflow";
import { guardarNotaCashflowTool, consultarNotasCashflowTool } from "./notasCashflow";
import { consultarEstadoFacturaHoldedTool } from "./consultarEstadoFacturaHolded";

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
  consultarEventosCalendarioTool,
  verificarCashflowActualizadoTool,
  proponerRegistroCashflowTool,
  capturarCorreoTool,
  saldosBancariosTool,
  generarReporteContableTool,
  directorioPersonasTool,
  verificarGastosSinMovimientoBancarioTool,
  verificarNumeracionCashflowTool,
  guardarNotaCashflowTool,
  consultarNotasCashflowTool,
  consultarEstadoFacturaHoldedTool,
];

/**
 * Definiciones en el formato que espera el parámetro `tools` de la API de
 * Anthropic. Con `modoRapido: true` (usado para el primer intento con Haiku
 * — ver core/claude/client.ts), solo incluye las herramientas marcadas
 * `seguraParaModoRapido` (solo lectura, sin ningún efecto secundario) —
 * cualquier herramienta nueva queda excluida de ese modo por defecto hasta
 * que alguien la marque explícitamente segura.
 */
export function getToolDefinitions(modoRapido = false): Anthropic.Tool[] {
  const disponibles = modoRapido ? tools.filter((t) => t.seguraParaModoRapido) : tools;
  return disponibles.map(({ name, description, input_schema }) => ({
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

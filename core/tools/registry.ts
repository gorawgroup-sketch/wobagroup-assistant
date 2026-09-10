import type Anthropic from "@anthropic-ai/sdk";
import type { ToolContext, ToolDefinition } from "./types";
import { ejecutarHerramienta, esLecturaParalela } from "./execution";
import { ejecutarLoteOrdenado } from "./batch";
import { configuracionConcurrencia } from "./scheduler";
import { knowledgeBaseTool } from "./knowledgeBase";
import { cashflowResumenTool } from "./cashflowResumen";
import { cashflowDetalleTool } from "./cashflowDetalle";
import { holdedMovimientosTool } from "./holdedMovimientos";
import { driveSearchTool } from "./driveSearch";
import { driveListFoldersTool } from "./driveListFolders";
import { leerDocumentoDriveTool } from "./leerDocumentoDrive";
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
import { anotacionesCashflowTool } from "./anotacionesCashflow";
import { confirmarArchivoPendienteTool } from "./confirmarArchivoPendiente";
import { listarCorreosSinLeerTool } from "./listarCorreosSinLeer";
import { reintentarContactoPendienteTool } from "./reintentarContactoPendiente";
import { fijarAliasProveedorTool } from "./fijarAliasProveedor";
import { reintentarGastoPendienteTool } from "./reintentarGastoPendiente";
import { reenviarBotonesPropuestaGastoTool } from "./reenviarBotonesPropuestaGasto";
import { reclasificarDocumentoPendienteTool, descartarDocumentoPendienteTool } from "./reclasificarDocumentoPendiente";
import { saltarCorreoActivoTool } from "./saltarCorreoActivo";
import { conciliarMovimientoTool } from "./conciliarMovimiento";
import { programarAccionFuturaTool } from "./programarAccion";
import { proponerEdicionCompraHoldedTool } from "./editarCompraHolded";
import { editarValorCashflowTool } from "./editarValorCashflow";
import { registrarManualCashflowTool } from "./registrarManualCashflow";
import { reporteAprendizajeTool } from "./reporteAprendizaje";
import { buscarGastosPorEtiquetaTool } from "./buscarGastosPorEtiqueta";
import { leerAdjuntosCompraHoldedTool } from "./leerAdjuntosCompraHolded";
import { revisarCorreoPuntualTool } from "./revisarCorreoPuntual";
import { gestionarContactoAutorespuestaTool } from "./gestionarContactoAutorespuesta";
import { marcarCorreoLeidoTool } from "./marcarCorreoLeido";
import { escalarDesarrolloTool } from "./escalarDesarrollo";

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
  leerDocumentoDriveTool,
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
  anotacionesCashflowTool,
  confirmarArchivoPendienteTool,
  listarCorreosSinLeerTool,
  reintentarContactoPendienteTool,
  fijarAliasProveedorTool,
  reintentarGastoPendienteTool,
  reenviarBotonesPropuestaGastoTool,
  reclasificarDocumentoPendienteTool,
  descartarDocumentoPendienteTool,
  saltarCorreoActivoTool,
  conciliarMovimientoTool,
  programarAccionFuturaTool,
  proponerEdicionCompraHoldedTool,
  editarValorCashflowTool,
  registrarManualCashflowTool,
  reporteAprendizajeTool,
  buscarGastosPorEtiquetaTool,
  leerAdjuntosCompraHoldedTool,
  revisarCorreoPuntualTool,
  gestionarContactoAutorespuestaTool,
  marcarCorreoLeidoTool,
  escalarDesarrolloTool,
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

  return ejecutarHerramienta(tool, input, context);
}

/** Única frontera para lotes conversacionales. La autorización se comprueba ANTES de admitir trabajo. */
export async function executeToolBatch(
  bloques: readonly Anthropic.ToolUseBlock[],
  nombresPermitidos: ReadonlySet<string>,
  context: ToolContext = {}
): Promise<Anthropic.ToolResultBlockParam[]> {
  return ejecutarLoteOrdenado(bloques, (bloque) => {
    if (!nombresPermitidos.has(bloque.name)) return false;
    const tool = tools.find((t) => t.name === bloque.name);
    return tool !== undefined && esLecturaParalela(tool);
  }, async (bloque, signal): Promise<Anthropic.ToolResultBlockParam> => {
    if (!nombresPermitidos.has(bloque.name)) {
      return {
        type: "tool_result", tool_use_id: bloque.id, is_error: true,
        content: `Error: la herramienta "${bloque.name}" no está disponible en este contexto.`,
      };
    }
    const content = await executeTool(bloque.name, bloque.input as Record<string, unknown>, {
      ...context, signal: context.signal ? AbortSignal.any([context.signal, signal]) : signal,
    });
    return { type: "tool_result", tool_use_id: bloque.id, content };
  }, configuracionConcurrencia().paralelo);
}

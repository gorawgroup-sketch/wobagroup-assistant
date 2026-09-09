import type { ToolContext, ToolDefinition } from "./types";
import { conTiempoMaximo, enteroAcotado, TiempoMaximoExcedidoError } from "../utils/asyncTimeout";

export async function ejecutarHerramienta(
  tool: ToolDefinition, input: Record<string, unknown>, context: ToolContext,
  limiteMs = enteroAcotado(process.env.WOBI_READ_TOOL_TIMEOUT_MS, 45_000, 5_000, 180_000)
): Promise<string> {
  if (!tool.seguraParaModoRapido) context.antesDeEfecto?.();
  try {
    // Lista explícita de lecturas auditadas, sin modelos anidados ni efectos de negocio.
    if (tool.lecturaAcotable && tool.seguraParaModoRapido) {
      return await conTiempoMaximo(() => Promise.resolve(tool.handler(input, context)), limiteMs, tool.name);
    }
    return await tool.handler(input, context);
  } catch (error) {
    // No devolver un timeout como tool_result: el modelo podría repetir la consulta en bucle.
    if (error instanceof TiempoMaximoExcedidoError) throw error;
    // Un fallo de transporte tras una escritura no confirma que no se ejecutó.
    if (!tool.seguraParaModoRapido) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return `Error ejecutando la herramienta "${tool.name}": ${message}`;
  }
}

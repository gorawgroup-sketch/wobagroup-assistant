import type { ToolContext, ToolDefinition } from "./types";
import { conTiempoMaximo, enteroAcotado, TiempoMaximoExcedidoError } from "../utils/asyncTimeout";
import { planificadorHerramientas, type PlanificadorHerramientas, type AccesoHerramienta } from "./scheduler";

export function esLecturaParalela(tool: ToolDefinition): boolean {
  return Boolean(tool.seguraParaModoRapido && tool.lecturaAcotable && tool.lecturaParalela);
}

export function accesoHerramienta(tool: ToolDefinition, input: Record<string, unknown>, context: ToolContext): AccesoHerramienta {
  const identidad = String(context.chatId ?? "sin_identidad");
  if (!esLecturaParalela(tool)) return { identidad, modo: "escritura", recursos: ["*"] };
  const empresa = ["WOBA", "EWORKS", "Footprint"].includes(String(input.empresa)) ? String(input.empresa) : "*";
  return { identidad, modo: "lectura", recursos: tool.lecturaParalela === "cashflow" ? ["cashflow"]
    : empresa === "*" ? ["*"] : [`holded:${empresa}`] };
}

export async function ejecutarHerramienta(
  tool: ToolDefinition, input: Record<string, unknown>, context: ToolContext,
  limiteMs = enteroAcotado(process.env.WOBI_READ_TOOL_TIMEOUT_MS, 45_000, 5_000, 180_000),
  planificador: PlanificadorHerramientas = planificadorHerramientas
): Promise<string> {
  const controller = new AbortController();
  const entrada = Date.now();
  const registrar = (fase: string, extra: Record<string, unknown> = {}) => {
    // Solo nombres del registro y métricas; jamás argumentos, resultados, chatId ni errores crudos.
    console.log("[tools/run]", JSON.stringify({ ejecucionId: context.ejecucionId, herramienta: tool.name, fase, ...extra }));
  };
  const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
  const ejecutar = () => planificador.ejecutar(accesoHerramienta(tool, input, context), async () => {
    const inicio = Date.now();
    registrar("iniciada", { esperaMs: inicio - entrada });
    if (!tool.seguraParaModoRapido) context.antesDeEfecto?.();
    try { return await tool.handler(input, context); }
    finally { registrar("finalizada", { duracionMs: Date.now() - inicio }); }
  }, signal);
  try {
    // Lista explícita de lecturas auditadas, sin modelos anidados ni efectos de negocio.
    if (tool.lecturaAcotable && tool.seguraParaModoRapido) {
      return await conTiempoMaximo(ejecutar, limiteMs, tool.name);
    }
    return await ejecutar();
  } catch (error) {
    registrar("error", { tipo: error instanceof Error ? error.name : "Error", transcurridoMs: Date.now() - entrada });
    // No devolver un timeout como tool_result: el modelo podría repetir la consulta en bucle.
    if (error instanceof TiempoMaximoExcedidoError) throw error;
    if (esLecturaParalela(tool)) throw error;
    // Un fallo de transporte tras una escritura no confirma que no se ejecutó.
    if (!tool.seguraParaModoRapido) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return `Error ejecutando la herramienta "${tool.name}": ${message}`;
  } finally {
    // Si venció esperando cupo, retirar la tarea. Si ya corría, conserva su reserva hasta terminar.
    controller.abort(new TiempoMaximoExcedidoError("lectura_finalizada", limiteMs));
  }
}

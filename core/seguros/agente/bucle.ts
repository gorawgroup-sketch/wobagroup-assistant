/**
 * Ciclo de herramientas del especialista: pregunta al modelo, ejecuta las herramientas que pide y vuelve a preguntar
 * hasta que contesta con texto. Es deliberadamente pequeño y propio (no reutiliza el del chat principal: aquel lleva
 * historial, pendientes y escalado entre modelos que aquí no pintan nada).
 *
 * Contención de coste: tope de pasos; si se agota, una última llamada SIN herramientas para que cierre con lo que ya
 * sabe en vez de fallar. Cada llamada pasa por el gateway de IA (política, presupuesto y registro de coste).
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { HerramientaAgente } from "./herramientas";

export type CrearMensaje = (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;

export interface OpcionesBucle {
  system: Anthropic.TextBlockParam[];
  mensajeInicial: string;
  herramientas: HerramientaAgente[];
  modelo: string;
  maxIteraciones: number;
  maxTokensRespuesta: number;
  crearMensaje: CrearMensaje;
}

export interface ResultadoBucle {
  texto: string;
  iteraciones: number;
  herramientasUsadas: string[];
  /** true si se agotaron los pasos y la respuesta es un cierre forzado. */
  cortadoPorLimite: boolean;
}

export const AVISO_RESPUESTA_RECORTADA = "[Respuesta recortada por longitud: pídeme que continúe y sigo desde aquí.]";

export function textoDeLaRespuesta(contenido: Anthropic.ContentBlock[]): string {
  return contenido
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export async function ejecutarBucle(o: OpcionesBucle): Promise<ResultadoBucle> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: o.mensajeInicial }];
  const definiciones = o.herramientas.map((h) => h.definicion);
  const porNombre = new Map(o.herramientas.map((h) => [h.definicion.name, h]));
  const usadas: string[] = [];

  for (let iteracion = 1; iteracion <= o.maxIteraciones; iteracion++) {
    const respuesta = await o.crearMensaje({
      model: o.modelo,
      max_tokens: o.maxTokensRespuesta,
      system: o.system,
      tools: definiciones,
      messages,
    });
    const usos = respuesta.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (respuesta.stop_reason !== "tool_use" || usos.length === 0) {
      // Una respuesta cortada a media frase no se entrega como si estuviera completa.
      const texto = textoDeLaRespuesta(respuesta.content);
      return {
        texto: respuesta.stop_reason === "max_tokens" && texto ? `${texto}\n\n${AVISO_RESPUESTA_RECORTADA}` : texto,
        iteraciones: iteracion,
        herramientasUsadas: usadas,
        cortadoPorLimite: false,
      };
    }

    messages.push({ role: "assistant", content: respuesta.content });
    const resultados: Anthropic.ToolResultBlockParam[] = [];
    // Una tras otra, en el orden pedido: las escrituras dependen del orden y así no se lanza una ráfaga de lecturas pesadas.
    for (const uso of usos) {
      usadas.push(uso.name);
      const herramienta = porNombre.get(uso.name);
      if (!herramienta) {
        resultados.push({ type: "tool_result", tool_use_id: uso.id, is_error: true, content: `Error: la herramienta «${uso.name}» no existe.` });
        continue;
      }
      try {
        const salida = await herramienta.ejecutar((uso.input ?? {}) as Record<string, unknown>);
        resultados.push({ type: "tool_result", tool_use_id: uso.id, content: salida, ...(salida.startsWith("Error") ? { is_error: true } : {}) });
      } catch (error) {
        resultados.push({
          type: "tool_result", tool_use_id: uso.id, is_error: true,
          content: `Error ejecutando «${uso.name}»: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    messages.push({ role: "user", content: resultados });
  }

  // Límite de pasos: cierre sin herramientas (tool_choice none) para que la persona reciba una respuesta útil.
  messages.push({
    role: "user",
    content: "Has llegado al límite de pasos de esta consulta. Responde ahora con lo que ya sabes: di qué comprobaste, qué quedó sin comprobar y qué haría falta para cerrarlo.",
  });
  const cierre = await o.crearMensaje({
    model: o.modelo,
    max_tokens: o.maxTokensRespuesta,
    system: o.system,
    tools: definiciones,
    tool_choice: { type: "none" },
    messages,
  });
  const textoCierre = textoDeLaRespuesta(cierre.content);
  return {
    texto: cierre.stop_reason === "max_tokens" && textoCierre ? `${textoCierre}\n\n${AVISO_RESPUESTA_RECORTADA}` : textoCierre,
    iteraciones: o.maxIteraciones + 1,
    herramientasUsadas: usadas,
    cortadoPorLimite: true,
  };
}

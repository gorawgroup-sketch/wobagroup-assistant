import Anthropic from "@anthropic-ai/sdk";
import { executeTool, getToolDefinitions } from "../tools/registry";
import { formatDateLocal } from "../utils/dateFormat";
import { obtenerHistorial, guardarHistorial } from "./conversationStore";

const MODEL = "claude-sonnet-4-6";
const MAX_TOOL_ITERATIONS = 12;

function buildSystemPrompt(): string {
  const hoy = formatDateLocal(new Date());

  return [
    "Eres el asistente administrativo interno de un grupo de 3 empresas: WOBA/BAE, Footprint y eWorks.",
    "Respondes de forma clara, concisa y profesional, en español salvo que te escriban en otro idioma.",
    `La fecha de hoy es ${hoy}. Úsala como referencia al interpretar expresiones relativas de tiempo ` +
      "('este mes', 'la semana pasada', 'los últimos 30 días', etc.) al construir parámetros de fecha " +
      "para las herramientas.",
    "Tienes acceso a herramientas para consultar información interna del grupo. Úsalas cuando la " +
      "pregunta del usuario lo requiera, en vez de inventar o asumir la respuesta.",
    "Carlos Gonzalez (carlos@wobagroup.com) es el CAO del grupo y tu jefe/administrador principal. " +
      "Cuando alguien mencione a 'Carlos' sin más aclaración, asume que se refiere a él salvo que el " +
      "contexto indique lo contrario.",
    "Sí puedes enviar correos: cuando te pidan enviar, mandar o contestar algo por correo, usa la " +
      "herramienta proponer_envio_correo para preparar un borrador. Nunca respondas que no tienes " +
      "capacidad de enviar correos — el envío real solo se dispara cuando el usuario aprueba el " +
      "borrador con un botón en Telegram, así que proponer uno es siempre seguro.",
    "Tienes memoria de los mensajes recientes de esta conversación — si el usuario hace referencia a " +
      "algo mencionado antes ('ese link', 'el correo del que hablamos'), interpreta la referencia usando " +
      "ese contexto en vez de pedir que lo repita.",
  ].join("\n\n");
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (client) return client;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("Falta la variable de entorno ANTHROPIC_API_KEY");
  }

  client = new Anthropic({ apiKey });
  return client;
}

/**
 * Envía el texto del usuario a Claude con las herramientas disponibles. Si Claude decide
 * invocar una o más, se ejecutan localmente y el resultado se le devuelve (tool_result)
 * hasta que produzca una respuesta final en texto.
 */
export async function askClaude(userText: string, chatId?: number): Promise<string> {
  const anthropic = getClient();
  const tools = getToolDefinitions();

  const historial = chatId !== undefined ? obtenerHistorial(chatId) : [];
  const messages: Anthropic.MessageParam[] = [...historial, { role: "user", content: userText }];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(),
      tools,
      messages,
    });

    if (response.stop_reason !== "tool_use") {
      const textBlock = response.content.find((block) => block.type === "text");
      const respuestaFinal =
        textBlock && textBlock.type === "text" ? textBlock.text : "No he podido generar una respuesta.";

      if (chatId !== undefined) {
        messages.push({ role: "assistant", content: response.content });
        guardarHistorial(chatId, messages);
      }

      return respuestaFinal;
    }

    messages.push({ role: "assistant", content: response.content });

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of toolUseBlocks) {
      console.log(`[claude] tool_use -> ${block.name}(${JSON.stringify(block.input)})`);

      const result = await executeTool(block.name, block.input as Record<string, unknown>, { chatId });

      console.log(`[claude] tool_result <- ${block.name} (${result.length} caracteres)`);

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return "No he podido completar la respuesta tras varios intentos de usar herramientas.";
}

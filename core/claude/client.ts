import Anthropic from "@anthropic-ai/sdk";
import { loadKnowledgeBase } from "../knowledge/loader";

const MODEL = "claude-sonnet-4-6";

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

function buildSystemPrompt(): string {
  const knowledge = loadKnowledgeBase();

  return [
    "Eres el asistente administrativo interno de un grupo de 3 empresas: WOBA/BAE, Footprint y eWorks.",
    "Respondes de forma clara, concisa y profesional, en español salvo que te escriban en otro idioma.",
    "A continuación tienes el documento de responsabilidades del grupo como contexto de referencia:",
    "---",
    knowledge || "(No se ha cargado ningún documento de responsabilidades todavía.)",
    "---",
  ].join("\n\n");
}

/**
 * Envía el texto del usuario a Claude junto con el contexto de la base de conocimiento
 * y devuelve la respuesta en texto plano.
 */
export async function askClaude(userText: string): Promise<string> {
  const anthropic = getClient();

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: buildSystemPrompt(),
    messages: [{ role: "user", content: userText }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  return textBlock && textBlock.type === "text"
    ? textBlock.text
    : "No he podido generar una respuesta.";
}

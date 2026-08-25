import Anthropic from "@anthropic-ai/sdk";
import { knowledgeBaseTool } from "../tools/knowledgeBase";

const MODEL = "claude-sonnet-4-6";
const MAX_ITERATIONS = 5;

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

export type EmpresaDocumento = "WOBA" | "EWORKS" | "Footprint" | "desconocida";

export interface ClasificacionDocumento {
  empresa: EmpresaDocumento;
  tipoDocumento: string;
  carpetaSugerida: string;
  confianza: "alta" | "media" | "baja";
  razon: string;
  preguntaSiAmbiguo?: string;
}

const REPORTAR_TOOL_NAME = "reportar_clasificacion_documento";

const REPORTAR_TOOL: Anthropic.Tool = {
  name: REPORTAR_TOOL_NAME,
  description:
    "Reporta la clasificación final propuesta para el documento entrante. Debes llamarla siempre al " +
    "terminar de razonar — nunca respondas solo en texto.",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: ["WOBA", "EWORKS", "Footprint", "desconocida"] },
      tipo_documento: {
        type: "string",
        description: "Tipo de documento, ej. 'factura', 'contrato', 'certificado ISO', 'otro'.",
      },
      carpeta_sugerida: {
        type: "string",
        description: "Carpeta o ruta sugerida dentro de Drive donde archivarlo.",
      },
      confianza: { type: "string", enum: ["alta", "media", "baja"] },
      razon: { type: "string", description: "Explicación breve de por qué se propone esta clasificación." },
      pregunta_si_ambiguo: {
        type: "string",
        description:
          "Solo si confianza='baja': la pregunta exacta para desambiguar con el usuario, en vez de adivinar.",
      },
    },
    required: ["empresa", "tipo_documento", "carpeta_sugerida", "confianza", "razon"],
  },
};

const SYSTEM_PROMPT = [
  "Eres el clasificador de documentos entrantes del grupo (WOBA/BAE, Footprint, eWorks).",
  "Te llega el nombre de un archivo y, si existe, el texto/caption que el usuario escribió al enviarlo " +
    "por Telegram. Tu trabajo es proponer a qué empresa pertenece el documento y en qué tipo de carpeta " +
    "debería archivarse, basándote en esas pistas.",
  "Si hace falta contexto sobre qué tipos de documentos van a qué carpetas (ej. documentos de un " +
    "colaborador nuevo, de un proveedor, de ISO...), usa la herramienta consultar_base_conocimiento " +
    "(documento de responsabilidades del grupo) antes de decidir.",
  "No tienes acceso al contenido del archivo (PDF/imagen), solo al nombre y al caption — no inventes ni " +
    "asumas contenido que no esté en esas pistas.",
  "Si la información es insuficiente para proponer con confianza razonable, marca confianza='baja' y en " +
    "'pregunta_si_ambiguo' escribe la pregunta exacta para desambiguar con el usuario, en vez de adivinar.",
  `SIEMPRE debes terminar llamando a la herramienta ${REPORTAR_TOOL_NAME} con tu conclusión final.`,
].join("\n\n");

/**
 * Clasifica un documento entrante usando solo el nombre de archivo y el
 * caption (sin leer contenido), con Claude apoyándose en
 * consultar_base_conocimiento cuando hace falta contexto. Nunca sube nada a
 * Drive — solo propone una clasificación.
 */
export async function clasificarDocumento(
  nombreArchivo: string,
  caption: string | undefined
): Promise<ClasificacionDocumento> {
  const anthropic = getClient();

  const tools: Anthropic.Tool[] = [
    {
      name: knowledgeBaseTool.name,
      description: knowledgeBaseTool.description,
      input_schema: knowledgeBaseTool.input_schema,
    },
    REPORTAR_TOOL,
  ];

  const userText = [
    `Nombre del archivo: ${nombreArchivo}`,
    caption ? `Texto adjunto (caption): ${caption}` : "(sin texto adjunto)",
  ].join("\n");

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userText }];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    const reportar = toolUseBlocks.find((b) => b.name === REPORTAR_TOOL_NAME);
    if (reportar) {
      const input = reportar.input as Record<string, unknown>;
      return {
        empresa: (input.empresa as EmpresaDocumento) ?? "desconocida",
        tipoDocumento: (input.tipo_documento as string) ?? "otro",
        carpetaSugerida: (input.carpeta_sugerida as string) ?? "(sin sugerencia)",
        confianza: (input.confianza as ClasificacionDocumento["confianza"]) ?? "baja",
        razon: (input.razon as string) ?? "",
        preguntaSiAmbiguo: input.pregunta_si_ambiguo as string | undefined,
      };
    }

    if (toolUseBlocks.length === 0) {
      break; // Claude respondió solo en texto sin llamar al tool obligatorio; usamos el fallback.
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      if (block.name === knowledgeBaseTool.name) {
        console.log(`[classifyFile] tool_use -> ${block.name}(${JSON.stringify(block.input)})`);
        const resultado = await knowledgeBaseTool.handler(block.input as Record<string, unknown>);
        console.log(`[classifyFile] tool_result <- ${block.name} (${resultado.length} caracteres)`);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: resultado });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    empresa: "desconocida",
    tipoDocumento: "otro",
    carpetaSugerida: "(sin sugerencia)",
    confianza: "baja",
    razon: "No fue posible clasificar automáticamente.",
    preguntaSiAmbiguo: "¿A qué empresa y carpeta pertenece este documento?",
  };
}

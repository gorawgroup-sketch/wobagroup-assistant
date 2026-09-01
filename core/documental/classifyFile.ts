import Anthropic from "@anthropic-ai/sdk";
import { knowledgeBaseTool } from "../tools/knowledgeBase";
import { listarSubcarpetas } from "../drive/client";
import { ROOT_FOLDERS, type EmpresaConCarpeta } from "../drive/rootFolders";
import { registrarUsoIA } from "../claude/costTracking";

const MODEL = "claude-sonnet-4-6";
const MAX_ITERATIONS = 6;

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
  /**
   * true si el texto/caption (típicamente el cuerpo de un correo) pide
   * explícitamente que se RECUERDE o quede registrado este contenido (ej.
   * "para que lo memorices", "que quede de referencia", "guárdalo para
   * consultarlo después") — señal de que además de archivar el documento,
   * hace falta guardarlo como conocimiento (CAPTURA). Caso real que motivó
   * esto: un colaborador mandó una lista de accesos activos por correo
   * diciendo "para que lo memorices" y el sistema solo propuso archivarlo
   * en Drive, sin reconocer que también pedían que quedara como
   * conocimiento consultable.
   */
  pareceIntencionDeCaptura?: boolean;
}

const REPORTAR_TOOL_NAME = "reportar_clasificacion_documento";
const LISTAR_CARPETAS_TOOL_NAME = "listar_carpetas_drive";

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
        description:
          "Nombre EXACTO (copiado literal, con emojis/mayúsculas si los trae) de una carpeta real " +
          "vista con listar_carpetas_drive. No inventes una ruta genérica si no la confirmaste ahí.",
      },
      confianza: { type: "string", enum: ["alta", "media", "baja"] },
      razon: { type: "string", description: "Explicación breve de por qué se propone esta clasificación." },
      pregunta_si_ambiguo: {
        type: "string",
        description:
          "Solo si confianza='baja': la pregunta exacta para desambiguar con el usuario, en vez de " +
          "adivinar. Si hay varias carpetas reales igual de plausibles, menciónalas por su nombre real.",
      },
      parece_intencion_de_captura: {
        type: "boolean",
        description:
          "true SOLO si el texto/caption (típicamente el cuerpo de un correo) pide explícitamente que " +
          "se RECUERDE o quede registrado este contenido (ej. 'para que lo memorices', 'que quede de " +
          "referencia', 'guárdalo para consultarlo después', 'anótalo'). No lo actives solo porque el " +
          "documento sea informativo — tiene que haber una petición explícita de recordarlo/registrarlo, " +
          "no solo de archivarlo.",
      },
    },
    required: ["empresa", "tipo_documento", "carpeta_sugerida", "confianza", "razon"],
  },
};

const LISTAR_CARPETAS_TOOL: Anthropic.Tool = {
  name: LISTAR_CARPETAS_TOOL_NAME,
  description:
    "Lista los nombres reales de las subcarpetas dentro de Drive para una empresa (WOBA, EWORKS o " +
    "Footprint). Sin 'carpeta_padre', lista las carpetas de primer nivel. Con 'carpeta_padre' (nombre " +
    "parcial de una carpeta ya vista), lista lo que hay DENTRO de esa carpeta. Úsala antes de proponer " +
    "una carpeta_sugerida — los nombres reales pueden traer emojis o variaciones que no adivinarías " +
    "(ej. 'SEGUROS📜'), y a veces hay más de una carpeta plausible (ej. 'SEGUROS📜' junto a una carpeta " +
    "separada 'MOTO PIAGGIO 300') que debes detectar para preguntar en vez de adivinar.",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: ["WOBA", "EWORKS", "Footprint"] },
      carpeta_padre: {
        type: "string",
        description: "Nombre (parcial) de una subcarpeta ya conocida, para listar su contenido. Opcional.",
      },
    },
    required: ["empresa"],
  },
};

const SYSTEM_PROMPT = [
  "Eres el clasificador de documentos entrantes del grupo (WOBA/BAE, Footprint, eWorks).",
  "Te llega el nombre de un archivo y, si existe, el texto/caption que el usuario escribió al enviarlo " +
    "por Telegram. Tu trabajo es proponer a qué empresa pertenece el documento y en qué carpeta REAL de " +
    "Drive debería archivarse, basándote en esas pistas.",
  "Antes de proponer una carpeta, usa listar_carpetas_drive para ver los nombres reales (de primer " +
    "nivel, y si hace falta explora dentro de alguna con carpeta_padre). NUNCA propongas una ruta " +
    "genérica o inventada ('Facturas/2025', etc.) — carpeta_sugerida debe ser el nombre EXACTO de una " +
    "carpeta que efectivamente viste con esta herramienta.",
  "Si al explorar encuentras más de una carpeta igual de plausible para este documento (ej. una carpeta " +
    "general de 'Seguros' y también una carpeta específica de un activo, como un vehículo, que podría " +
    "aplicar), NO elijas una al azar: marca confianza='baja' y en pregunta_si_ambiguo pregunta al " +
    "usuario mencionando los nombres reales de esas carpetas para que elija.",
  "Si hace falta contexto sobre qué tipos de documentos van a qué carpetas (ej. documentos de un " +
    "colaborador nuevo, de un proveedor, de ISO...), usa también consultar_base_conocimiento " +
    "(documento de responsabilidades del grupo).",
  "No tienes acceso al contenido del archivo (PDF/imagen), solo al nombre y al caption — no inventes ni " +
    "asumas contenido que no esté en esas pistas.",
  "Además de decidir dónde archivarlo, revisa si el caption (el texto del correo/mensaje que trae el " +
    "documento) pide explícitamente que se RECUERDE o quede registrado — no solo que se archive. Si es " +
    "así, marca parece_intencion_de_captura=true.",
  `SIEMPRE debes terminar llamando a la herramienta ${REPORTAR_TOOL_NAME} con tu conclusión final.`,
].join("\n\n");

/**
 * Clasifica un documento entrante usando solo el nombre de archivo y el
 * caption (sin leer contenido), con Claude apoyándose en
 * consultar_base_conocimiento y listar_carpetas_drive (nombres reales de
 * Drive) para no adivinar. Nunca sube nada a Drive — solo propone.
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
    LISTAR_CARPETAS_TOOL,
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

    // Bug real: esta llamada real a Claude nunca se registraba en
    // _costos_ia — el gasto real de clasificar documentos no aparecía.
    registrarUsoIA(undefined, MODEL, response.usage).catch((error) =>
      console.error("[classifyFile] Error registrando uso de IA:", error)
    );

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
        pareceIntencionDeCaptura: input.parece_intencion_de_captura === true,
      };
    }

    if (toolUseBlocks.length === 0) {
      break; // Claude respondió solo en texto sin llamar al tool obligatorio; usamos el fallback.
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      console.log(`[classifyFile] tool_use -> ${block.name}(${JSON.stringify(block.input)})`);

      let resultado: string;

      if (block.name === knowledgeBaseTool.name) {
        resultado = await knowledgeBaseTool.handler(block.input as Record<string, unknown>);
      } else if (block.name === LISTAR_CARPETAS_TOOL_NAME) {
        const input = block.input as { empresa?: EmpresaConCarpeta; carpeta_padre?: string };
        const rootId = input.empresa ? ROOT_FOLDERS[input.empresa] : undefined;
        if (!rootId) {
          resultado = `Error: empresa "${input.empresa}" no reconocida.`;
        } else {
          const nombres = await listarSubcarpetas(rootId, input.carpeta_padre);
          resultado = nombres.length > 0 ? nombres.join("\n") : "(sin subcarpetas encontradas ahí)";
        }
      } else {
        continue;
      }

      console.log(`[classifyFile] tool_result <- ${block.name} (${resultado.length} caracteres)`);
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: resultado });
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

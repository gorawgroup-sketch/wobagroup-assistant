import { readFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { knowledgeBaseTool } from "../tools/knowledgeBase";
import { obtenerClasificacionesAprendidas } from "../gastos/clasificacionAprendidaSheet";

const MODEL = "claude-sonnet-4-6";
const MAX_ITERATIONS = 4;

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

export type EmpresaGasto = "WOBA" | "EWORKS" | "Footprint" | "desconocida";

export interface DatosFactura {
  esFacturaOGasto: boolean;
  proveedor: string;
  monto: number;
  moneda: string;
  fecha: string; // YYYY-MM-DD, según lo que diga el documento
  concepto: string;
  empresaProbable: EmpresaGasto;
  confianza: "alta" | "media" | "baja";
  razon: string;
}

const REPORTAR_TOOL_NAME = "reportar_datos_factura";

const REPORTAR_TOOL: Anthropic.Tool = {
  name: REPORTAR_TOOL_NAME,
  description:
    "Reporta los datos extraídos del documento (o que no es una factura/gasto). Debes llamarla " +
    "siempre al terminar — nunca respondas solo en texto.",
  input_schema: {
    type: "object",
    properties: {
      es_factura_o_gasto: {
        type: "boolean",
        description: "true si el documento es una factura, recibo, ticket o comprobante de gasto/pago.",
      },
      proveedor: { type: "string", description: "Nombre del proveedor/emisor tal como aparece en el documento." },
      monto: { type: "number", description: "Importe total (numérico, sin símbolo de moneda)." },
      moneda: { type: "string", description: "Código de moneda, ej. EUR, USD." },
      fecha: { type: "string", description: "Fecha del documento en formato YYYY-MM-DD." },
      concepto: { type: "string", description: "Breve descripción de qué es el gasto." },
      empresa_probable: {
        type: "string",
        enum: ["WOBA", "EWORKS", "Footprint", "desconocida"],
        description: "A qué empresa del grupo pertenece este gasto, según el documento y el contexto conocido.",
      },
      confianza: { type: "string", enum: ["alta", "media", "baja"] },
      razon: { type: "string", description: "Explicación breve de la clasificación (o de por qué no es una factura)." },
    },
    required: ["es_factura_o_gasto", "confianza", "razon"],
  },
};

function buildSystemPrompt(clasificacionesAprendidas: string | null): string {
  return [
    "Eres el lector de facturas/gastos entrantes del grupo (WOBA/BAE, Footprint, eWorks).",
    "Recibes el contenido REAL de un documento (PDF o imagen) — léelo con atención, no adivines.",
    "Primero decide si es una factura, recibo, ticket o comprobante de gasto/pago. Si es cualquier otra " +
      "cosa (contrato, certificado, documento de RRHH, etc.), reporta es_factura_o_gasto=false y no " +
      "sigas extrayendo los demás campos.",
    "Si sí es un gasto, extrae proveedor, monto total, moneda, fecha y un concepto breve, tal como " +
      "aparecen en el documento — no inventes ni redondees.",
    "Para decidir la empresa probable (WOBA, EWORKS o Footprint), usa consultar_base_conocimiento si " +
      "hace falta contexto sobre qué proveedores/gastos son de cada empresa.",
    clasificacionesAprendidas
      ? `Además, estas son clasificaciones aprendidas de facturas anteriores del mismo proveedor — ` +
        `dales prioridad sobre cualquier suposición genérica:\n\n${clasificacionesAprendidas}`
      : "",
    "Si no tienes certeza de la empresa o algún dato clave, usa confianza='baja' o 'media' en vez de " +
      "inventar — es preferible preguntar que asumir mal en un tema de dinero.",
    `SIEMPRE debes terminar llamando a la herramienta ${REPORTAR_TOOL_NAME} con tu conclusión final.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// El SDK instalado (0.32.1) no declara tipos para bloques "document" (PDF) —
// la API sí los soporta (no son beta), así que se define el shape local y se
// castea al armar el mensaje, en vez de forzar un upgrade de SDK que toque
// el resto del proyecto por una sola función.
interface DocumentOrImageBlock {
  type: "document" | "image";
  source: { type: "base64"; media_type: string; data: string };
}

function mimeADocumentBlock(rutaLocal: string, mimeType: string | undefined, data: Buffer): DocumentOrImageBlock {
  const base64 = data.toString("base64");

  if (mimeType === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } };
  }

  const imageMimes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (mimeType && imageMimes.includes(mimeType)) {
    return { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } };
  }

  throw new Error(`Tipo de archivo no soportado para lectura de facturas: ${mimeType ?? "(desconocido)"} (${rutaLocal})`);
}

/**
 * Lee el CONTENIDO real de un documento (PDF/imagen, no solo su nombre) y
 * decide si es una factura/gasto y, si lo es, extrae sus datos. Nunca escribe
 * ni sube nada — es puramente lectura/clasificación, igual que
 * classifyFile.ts. Si el documento no es legible o no es una factura,
 * es_factura_o_gasto vuelve false para que el llamador siga el flujo normal
 * de archivado en Drive.
 */
export async function extraerDatosFactura(rutaLocal: string, mimeType: string | undefined): Promise<DatosFactura> {
  const fallback: DatosFactura = {
    esFacturaOGasto: false,
    proveedor: "",
    monto: 0,
    moneda: "",
    fecha: "",
    concepto: "",
    empresaProbable: "desconocida",
    confianza: "baja",
    razon: "No fue posible leer el documento.",
  };

  let documentBlock: DocumentOrImageBlock;
  try {
    const data = await readFile(rutaLocal);
    documentBlock = mimeADocumentBlock(rutaLocal, mimeType, data);
  } catch (error) {
    console.error("[extractInvoiceData] Error leyendo/preparando el archivo:", error);
    return fallback;
  }

  const anthropic = getClient();
  const clasificacionesAprendidas = await obtenerClasificacionesAprendidas().catch(() => null);

  const tools: Anthropic.Tool[] = [
    { name: knowledgeBaseTool.name, description: knowledgeBaseTool.description, input_schema: knowledgeBaseTool.input_schema },
    REPORTAR_TOOL,
  ];

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      // El cast es necesario porque el SDK instalado no declara bloques
      // "document"/"image" con source base64 en su tipo MessageParam,
      // aunque la API sí los acepta (ver DocumentOrImageBlock arriba).
      content: [documentBlock, { type: "text", text: "Lee este documento y reporta sus datos." }] as unknown as Anthropic.MessageParam["content"],
    },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(clasificacionesAprendidas),
      tools,
      messages,
    });

    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

    const reportar = toolUseBlocks.find((b) => b.name === REPORTAR_TOOL_NAME);
    if (reportar) {
      const input = reportar.input as Record<string, unknown>;
      return {
        esFacturaOGasto: Boolean(input.es_factura_o_gasto),
        proveedor: (input.proveedor as string) ?? "",
        monto: typeof input.monto === "number" ? input.monto : 0,
        moneda: (input.moneda as string) ?? "EUR",
        fecha: (input.fecha as string) ?? "",
        concepto: (input.concepto as string) ?? "",
        empresaProbable: (input.empresa_probable as EmpresaGasto) ?? "desconocida",
        confianza: (input.confianza as DatosFactura["confianza"]) ?? "baja",
        razon: (input.razon as string) ?? "",
      };
    }

    if (toolUseBlocks.length === 0) break;

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      if (block.name === knowledgeBaseTool.name) {
        const resultado = await knowledgeBaseTool.handler(block.input as Record<string, unknown>);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: resultado });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  return fallback;
}

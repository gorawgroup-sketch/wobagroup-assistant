import { readFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { knowledgeBaseTool } from "../tools/knowledgeBase";
import { obtenerClasificacionesAprendidas } from "../gastos/clasificacionAprendidaSheet";
import { registrarUsoIA } from "../claude/costTracking";

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

export interface LineaFactura {
  concepto: string;
  base: number;
  tipoIvaPct: number;
}

export interface DatosFactura {
  esFacturaOGasto: boolean;
  proveedor: string;
  /** Total real de la factura (base + todo el IVA), tal como aparece impreso — se usa para el matching. */
  monto: number;
  moneda: string;
  /**
   * Solo cuando `moneda` no es EUR: el equivalente en euros, SI el propio
   * documento lo muestra (ej. una notificación de tarjeta: "40.46 EUR |
   * 148.346 COP"). undefined si el documento no trae ningún equivalente en
   * euros — nunca se calcula ni se inventa un tipo de cambio. Caso real que
   * motivó esto: un gasto de Uber en Colombia se registró por error con
   * 148.346 (el monto en COP) tratado como si fueran EUR — la conciliación
   * bancaria es siempre en EUR, así que hace falta este campo para
   * registrar el monto correcto.
   */
  montoEUR?: number;
  fecha: string; // YYYY-MM-DD, según lo que diga el documento
  concepto: string;
  /** Desglose por tipo de IVA (una o varias líneas). El % es el que aparece impreso, no un código de Holded. */
  lineas: LineaFactura[];
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
      monto: { type: "number", description: "Importe TOTAL de la factura (base + todo el IVA), tal como aparece impreso." },
      moneda: { type: "string", description: "Código de moneda, ej. EUR, USD." },
      monto_eur: {
        type: "number",
        description:
          "SOLO si 'moneda' no es EUR: el equivalente en euros, ÚNICAMENTE si el propio documento lo " +
          "muestra explícitamente (ej. una notificación de tarjeta que dice '40.46 EUR | 148.346 COP', o " +
          "un recibo con una línea 'Total (EUR)'). Si el documento NO trae ningún equivalente en euros " +
          "impreso, omite este campo por completo — NUNCA calcules ni inventes un tipo de cambio tú mismo.",
      },
      fecha: { type: "string", description: "Fecha del documento en formato YYYY-MM-DD." },
      concepto: { type: "string", description: "Breve descripción de qué es el gasto." },
      lineas: {
        type: "array",
        description:
          "Desglose por tipo de IVA, tal como aparece en la factura (una línea por cada base+IVA " +
          "distinto). Si la factura no desglosa nada (un solo total, sin IVA separado), reporta UNA " +
          "línea con base = monto y tipo_iva_pct = 0 (nunca inventes un desglose que no está impreso).",
        items: {
          type: "object",
          properties: {
            concepto: { type: "string", description: "Descripción de esta línea/concepto." },
            base: { type: "number", description: "Base imponible de esta línea (sin IVA)." },
            tipo_iva_pct: {
              type: "number",
              description: "Porcentaje de IVA de esta línea tal como aparece impreso (ej. 21, 10, 0). NUNCA un código de Holded.",
            },
          },
          required: ["concepto", "base", "tipo_iva_pct"],
        },
      },
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
    "Extrae también el desglose de IVA en 'lineas': si la factura muestra bases y tipos de IVA " +
      "distintos (ej. una parte al 21% y otra al 10%), repórtalos como líneas separadas. Si solo hay un " +
      "total sin desglose, repórtalo como una sola línea. El porcentaje de IVA es el que está impreso " +
      "en el documento (un número como 21 o 10) — nunca un código interno de Holded, eso se resuelve " +
      "después con datos reales del sistema.",
    "Para decidir la empresa probable (WOBA, EWORKS o Footprint), usa consultar_base_conocimiento si " +
      "hace falta contexto sobre qué proveedores/gastos son de cada empresa.",
    "Si 'moneda' no es EUR y el documento muestra también el equivalente en euros (típico en " +
      "notificaciones de tarjeta por gastos en el extranjero: '40.46 EUR | 148.346 COP'), repórtalo en " +
      "'monto_eur' — la conciliación bancaria del grupo es siempre en euros, así que ese es el monto real " +
      "que salió de la cuenta, no el de la moneda local. Si el documento NO trae ningún equivalente en " +
      "euros, omite 'monto_eur' — nunca calcules tú un tipo de cambio.",
    "Además del documento adjunto, puede que recibas 'Contexto del correo' (asunto/cuerpo del mensaje " +
      "que traía este adjunto, ej. un reenvío de notificación bancaria). Es habitual que el recibo/factura " +
      "en sí (ej. de Uber) NO muestre el equivalente en euros, pero el correo que lo reenvía sí lo diga en " +
      "el asunto (ej. 'Fwd: 40.46 EUR | 148.346 COP - Uber'). En ese caso, usa ESE texto para reportar " +
      "'monto_eur' igual que si viniera impreso en el documento — sigue siendo un dato real, no un cálculo " +
      "tuyo. Si ni el documento ni el contexto del correo traen un equivalente en euros explícito, omite " +
      "'monto_eur'.",
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
export async function extraerDatosFactura(
  rutaLocal: string,
  mimeType: string | undefined,
  contextoCorreo?: string
): Promise<DatosFactura> {
  const fallback: DatosFactura = {
    esFacturaOGasto: false,
    proveedor: "",
    monto: 0,
    moneda: "",
    fecha: "",
    concepto: "",
    lineas: [],
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

  const textoInstruccion = contextoCorreo
    ? `Lee este documento y reporta sus datos.\n\nContexto del correo que traía este adjunto:\n${contextoCorreo}`
    : "Lee este documento y reporta sus datos.";

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      // El cast es necesario porque el SDK instalado no declara bloques
      // "document"/"image" con source base64 en su tipo MessageParam,
      // aunque la API sí los acepta (ver DocumentOrImageBlock arriba).
      content: [documentBlock, { type: "text", text: textoInstruccion }] as unknown as Anthropic.MessageParam["content"],
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

    // Bug real encontrado en vivo: esta llamada real a Claude nunca se
    // registraba en _costos_ia (a diferencia de core/claude/client.ts) —
    // el gasto real de leer facturas no aparecía en el panel de costos.
    registrarUsoIA(undefined, MODEL, response.usage).catch((error) =>
      console.error("[extractInvoiceData] Error registrando uso de IA:", error)
    );

    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

    const reportar = toolUseBlocks.find((b) => b.name === REPORTAR_TOOL_NAME);
    if (reportar) {
      const input = reportar.input as Record<string, unknown>;
      const monto = typeof input.monto === "number" ? input.monto : 0;

      const lineasRaw = Array.isArray(input.lineas) ? input.lineas : [];
      const lineas: LineaFactura[] = lineasRaw
        .map((l): LineaFactura | null => {
          if (typeof l !== "object" || l === null) return null;
          const linea = l as Record<string, unknown>;
          return {
            concepto: typeof linea.concepto === "string" ? linea.concepto : "",
            base: typeof linea.base === "number" ? linea.base : 0,
            tipoIvaPct: typeof linea.tipo_iva_pct === "number" ? linea.tipo_iva_pct : 0,
          };
        })
        .filter((l): l is LineaFactura => l !== null);

      return {
        esFacturaOGasto: Boolean(input.es_factura_o_gasto),
        proveedor: (input.proveedor as string) ?? "",
        monto,
        moneda: (input.moneda as string) ?? "EUR",
        montoEUR: typeof input.monto_eur === "number" ? input.monto_eur : undefined,
        fecha: (input.fecha as string) ?? "",
        concepto: (input.concepto as string) ?? "",
        // Si Claude no reportó líneas (o vinieron vacías), se usa una sola
        // línea con el total completo a 0% en vez de perder el importe —
        // crearGastoHolded siempre necesita al menos una línea.
        lineas: lineas.length > 0 ? lineas : [{ concepto: (input.concepto as string) ?? "", base: monto, tipoIvaPct: 0 }],
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

import { readFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { crearMensajeAnthropic } from "../ai/anthropicGateway";
import { crearEjecucionIA } from "../ai/policy";
import { resolverModeloDocumental } from "../ai/modelRouting";
import { mimeADocumentBlock } from "../documental/documentBlock";

/**
 * Lector de documentos de pólizas para Wobi Seguros (docs/wobi-seguros.md §4.2). Lee el contenido REAL del documento
 * y reporta, sin interpretar de más, qué póliza es y qué dice. No decide nada ni escribe en ningún sitio: quien llama
 * (integrarDocumentoPoliza.ts) lo guarda en el conocimiento de seguros.
 */
export interface DatosDocumentoPoliza {
  /** false si, al leerlo, el documento no resulta ser de una póliza de seguro: no se registra nada. */
  esDocumentoPoliza: boolean;
  tipoDocumento: string;
  numeroPoliza: string;
  suplemento: string;
  aseguradora: string;
  correduria: string;
  tomador: string;
  empresa: "WOBA" | "EWORKS" | "Footprint" | "desconocida";
  tipoCobertura: string;
  capitalAsegurado: string;
  franquicia: string;
  prima: string;
  moneda: string;
  vigenciaInicio: string;
  vigenciaFin: string;
  fechaDocumento: string;
  resumen: string;
}

const REPORTAR = "reportar_documento_poliza";
const TOOL: Anthropic.Tool = {
  name: REPORTAR,
  description: "Reporta lo que dice el documento de póliza. Debes llamarla siempre al terminar; nunca respondas solo en texto.",
  input_schema: {
    type: "object",
    properties: {
      es_documento_poliza: {
        type: "boolean",
        description:
          "true si es documentación de una póliza de seguro (condiciones particulares o generales, suplemento, " +
          "certificado, carta de garantía, nota de cobertura, cotización o propuesta de seguro). false si es otra cosa.",
      },
      tipo_documento: { type: "string", description: "Ej. 'condiciones particulares', 'suplemento', 'certificado', 'condiciones generales', 'cotización'." },
      numero_poliza: { type: "string", description: "Número de póliza tal como aparece impreso, sin el número de suplemento." },
      suplemento: { type: "string", description: "Número de suplemento si el documento es un suplemento (ej. '2', '3.3'); vacío si no." },
      aseguradora: { type: "string" },
      correduria: { type: "string", description: "Correduría o mediador, si aparece." },
      tomador: { type: "string", description: "Tomador del seguro tal como aparece (razón social)." },
      empresa: {
        type: "string",
        enum: ["WOBA", "EWORKS", "Footprint", "desconocida"],
        description:
          "Empresa del grupo a la que pertenece el tomador: WOBA (Business Atelier Europa SL / BAE / WOBA), EWORKS " +
          "(eWorks) o Footprint. 'desconocida' si el tomador no es ninguna de ellas.",
      },
      tipo_cobertura: { type: "string", description: "Qué se asegura, en pocas palabras (ej. 'RC General', 'Multirriesgo showroom')." },
      capital_asegurado: { type: "string", description: "Suma o límite asegurado principal, con su moneda, tal como aparece." },
      franquicia: { type: "string" },
      prima: { type: "string", description: "Prima total del periodo o del suplemento, tal como aparece (número con decimales)." },
      moneda: { type: "string", description: "Código ISO de la moneda de la prima (EUR, USD…)." },
      vigencia_inicio: { type: "string", description: "Fecha de efecto en formato AAAA-MM-DD, si aparece." },
      vigencia_fin: { type: "string", description: "Fecha de vencimiento en formato AAAA-MM-DD, si aparece." },
      fecha_documento: { type: "string", description: "Fecha de emisión del documento en formato AAAA-MM-DD, si aparece." },
      resumen: {
        type: "string",
        description:
          "Resumen fiel en español, de 6 a 12 líneas, de lo que un gestor necesita saber: qué cubre, actividades y " +
          "ubicaciones aseguradas, límites y sublímites, franquicias, exclusiones destacadas, qué cambia si es un " +
          "suplemento, y cualquier obligación o plazo para el tomador (firmas, pagos). Solo lo que el documento dice.",
      },
    },
    required: ["es_documento_poliza", "resumen"],
  },
};

const SYSTEM =
  "Eres el lector de documentos de pólizas de seguro del grupo (WOBA / Business Atelier Europa SL, eWorks, Footprint). " +
  "Recibes el contenido REAL de un documento: léelo completo y reporta sus datos tal como aparecen impresos. " +
  "No inventes, no completes con suposiciones y no redondees importes: un campo que el documento no trae se deja vacío. " +
  `Termina SIEMPRE llamando a ${REPORTAR}.`;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Falta la variable de entorno ANTHROPIC_API_KEY");
  client = new Anthropic({ apiKey });
  return client;
}

const texto = (valor: unknown): string => (typeof valor === "string" ? valor.trim() : "");

/** Convierte lo reportado por el modelo en datos tipados; exportada para probarla sin llamar a la IA. */
export function interpretarReportePoliza(input: Record<string, unknown>): DatosDocumentoPoliza {
  const empresa = texto(input.empresa);
  return {
    esDocumentoPoliza: input.es_documento_poliza === true || input.es_documento_poliza === "true",
    tipoDocumento: texto(input.tipo_documento),
    numeroPoliza: texto(input.numero_poliza),
    suplemento: texto(input.suplemento),
    aseguradora: texto(input.aseguradora),
    correduria: texto(input.correduria),
    tomador: texto(input.tomador),
    empresa: empresa === "WOBA" || empresa === "EWORKS" || empresa === "Footprint" ? empresa : "desconocida",
    tipoCobertura: texto(input.tipo_cobertura),
    capitalAsegurado: texto(input.capital_asegurado),
    franquicia: texto(input.franquicia),
    prima: texto(input.prima),
    moneda: texto(input.moneda).toUpperCase(),
    vigenciaInicio: texto(input.vigencia_inicio),
    vigenciaFin: texto(input.vigencia_fin),
    fechaDocumento: texto(input.fecha_documento),
    resumen: texto(input.resumen),
  };
}

export async function extraerDatosPoliza(
  rutaLocal: string,
  mimeType: string | undefined,
  contexto?: string
): Promise<DatosDocumentoPoliza> {
  const bloque = await mimeADocumentBlock(rutaLocal, mimeType, await readFile(rutaLocal));
  const ejecucion = crearEjecucionIA("extraer_poliza");
  const instruccion = "Lee este documento de seguros y reporta sus datos." + (contexto ? `\n\nContexto de cómo llegó:\n${contexto}` : "");
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: [bloque, { type: "text", text: instruccion }] as unknown as Anthropic.MessageParam["content"] },
  ];

  for (let intento = 0; intento < 2; intento++) {
    const respuesta = await crearMensajeAnthropic(getClient(), ejecucion, {
      // Mismo modelo y misma palanca de rollback que el lector de facturas: es la misma clase de lectura documental.
      model: resolverModeloDocumental("extraer_factura"),
      max_tokens: 8192,
      system: SYSTEM,
      tools: [TOOL],
      messages,
    });
    const reporte = respuesta.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === REPORTAR);
    if (reporte) return interpretarReportePoliza(reporte.input as Record<string, unknown>);
    messages.push({ role: "assistant", content: respuesta.content });
    messages.push({ role: "user", content: `Falta el reporte: llama a ${REPORTAR} con los datos del documento.` });
  }
  throw new Error("El lector de pólizas no reportó los datos del documento.");
}

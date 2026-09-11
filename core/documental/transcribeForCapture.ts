import { readFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { crearMensajeAnthropic } from "../ai/anthropicGateway";
import { crearEjecucionIA } from "../ai/policy";
import { resolverModeloDocumental } from "../ai/modelRouting";
import { mimeADocumentBlock } from "./documentBlock";

const MODEL = resolverModeloDocumental("transcribir_captura");
// Sin cache_control deliberadamente: la parte estable de esta petición está muy por debajo del
// mínimo cacheable de Sonnet (1.024 tokens). Marcarla no generaría hits ni ahorro; el documento y su
// contexto sí cambian en cada llamada. Se conserva el prompt exacto y solo se optimiza el modelo.

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
 * Transcribe el CONTENIDO real de un documento/imagen (PDF, foto, captura
 * de pantalla) a texto, para poder guardarlo como CAPTURA en la base de
 * conocimiento — a diferencia de clasificarDocumento (que solo decide dónde
 * archivarlo, sin leer el contenido), esto sí lee el archivo con Claude
 * vision. Pedido explícito de Carlos tras un caso real: un colaborador
 * mandó una captura de pantalla con una lista de accesos activos diciendo
 * "para que lo memorices" — para que esa lista quede como conocimiento
 * REAL consultable (no solo "se archivó un archivo"), hace falta el texto
 * real de la imagen, no solo su nombre.
 *
 * Nunca escribe nada — solo devuelve el texto transcrito para que el
 * llamador decida qué hacer con él (ver processClassification.ts).
 */
export async function transcribirParaCaptura(
  rutaLocal: string,
  mimeType: string | undefined,
  contexto: string | undefined
): Promise<string> {
  const anthropic = getClient();
  const ejecucion = crearEjecucionIA("transcribir_captura");

  const data = await readFile(rutaLocal);
  const documentBlock = mimeADocumentBlock(rutaLocal, mimeType, data);

  const textoInstruccion = [
    "Transcribe el contenido real de este documento/imagen en texto, de forma clara y completa — es " +
      "para guardarlo como conocimiento consultable del equipo, así que prioriza los datos concretos " +
      "(listas, nombres, fechas, cifras, decisiones) tal como aparecen, no un resumen vago.",
    contexto ? `Contexto de quién lo mandó y por qué (úsalo para dar marco, no lo repitas literal):\n${contexto}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const response = await crearMensajeAnthropic(anthropic, ejecucion, {
    model: MODEL,
    max_tokens: 1500,
    messages: [
      {
        role: "user",
        content: [documentBlock, { type: "text", text: textoInstruccion }] as unknown as Anthropic.MessageParam["content"],
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const texto = textBlock && textBlock.type === "text" ? textBlock.text.trim() : "";
  if (!texto) {
    throw new Error("Claude no devolvió ninguna transcripción para este documento.");
  }
  return texto;
}

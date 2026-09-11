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

// Hallazgo real de auditoría (pedido explícito de Carlos, 2026-09-11 — un blueprint técnico real
// sobre backup automático Holded→Drive, reenviado como parte de una reunión): "me gustaría que
// analizaras mucho mejor, leyeras el contenido del documento... e integrarlo a tu conocimiento". Con
// max_tokens=1500 (≈1000-1100 palabras) esta función truncaba en silencio cualquier documento técnico
// real de más de un par de páginas — sin ningún aviso, ni de que se cortó ni de dónde. Se sube al
// mismo techo ya establecido en este proyecto para lecturas de documentos que no pueden perder datos
// (ver extractInvoiceData.ts, max_tokens=8192) y, para el caso raro de que ni así alcance, se agrega
// un bucle de continuación acotado (máximo 3 turnos) que le pide seguir EXACTAMENTE donde se cortó —
// mismo patrón multi-turno ya usado en extractInvoiceData.ts, adaptado acá para texto libre en vez de
// tool-calling. Nunca se devuelve un texto truncado en silencio: si aun con los 3 turnos se sigue
// cortando, se lo dice explícitamente al final en vez de fingir que la transcripción quedó completa.
const MAX_TURNOS_TRANSCRIPCION = 3;

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
    "Transcribe el contenido real de este documento/imagen en texto, de forma clara y COMPLETA — es " +
      "para guardarlo como conocimiento consultable del equipo, así que prioriza los datos concretos " +
      "(listas, nombres, fechas, cifras, decisiones, pasos de un proceso) tal como aparecen, no un " +
      "resumen vago. Si el documento es largo (varias páginas, un proceso con muchos pasos), " +
      "transcríbelo TODO igual — nunca resumas ni omitas secciones para ahorrar espacio.",
    contexto ? `Contexto de quién lo mandó y por qué (úsalo para dar marco, no lo repitas literal):\n${contexto}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: [documentBlock, { type: "text", text: textoInstruccion }] as unknown as Anthropic.MessageParam["content"],
    },
  ];

  let textoCompleto = "";
  let seCorto = false;

  for (let turno = 0; turno < MAX_TURNOS_TRANSCRIPCION; turno++) {
    const response = await crearMensajeAnthropic(anthropic, ejecucion, {
      model: MODEL,
      max_tokens: 8192,
      messages,
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const texto = textBlock && textBlock.type === "text" ? textBlock.text : "";
    textoCompleto += texto;

    if (response.stop_reason !== "max_tokens") {
      seCorto = false;
      break;
    }

    seCorto = true;
    if (turno === MAX_TURNOS_TRANSCRIPCION - 1) break;

    messages.push({ role: "assistant", content: response.content });
    messages.push({
      role: "user",
      content: "Continúa la transcripción EXACTAMENTE donde la dejaste — nunca repitas lo que ya transcribiste arriba.",
    });
  }

  textoCompleto = textoCompleto.trim();
  if (!textoCompleto) {
    throw new Error("Claude no devolvió ninguna transcripción para este documento.");
  }

  if (seCorto) {
    console.error(`[transcribeForCapture] Transcripción de "${rutaLocal}" se cortó por longitud incluso tras ${MAX_TURNOS_TRANSCRIPCION} turnos — puede quedar incompleta.`);
    textoCompleto += "\n\n[⚠️ Esta transcripción se cortó por longitud — el documento es más largo de lo que se pudo capturar. Puede faltar contenido del final.]";
  }

  return textoCompleto;
}

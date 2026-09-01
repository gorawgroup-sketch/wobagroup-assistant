import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buscarMensajes, obtenerResumenCorreo, obtenerCuerpoCompletoCorreo, descargarAdjunto } from "../gmail/client";
import { registrarCaptura } from "../knowledge/capturaSheet";
import { procesarDocumentoLocal } from "../documental/procesarDocumentoLocal";
import type { ToolDefinition } from "./types";

const UPLOADS_DIR = join(process.cwd(), "tmp", "uploads");

function sanitizarNombre(nombre: string): string {
  return nombre.replace(/[^\w.\-]+/g, "_").slice(0, 150);
}

/**
 * Guarda el contenido REAL de un correo entrante en la base de conocimiento
 * — a diferencia de un mensaje "CAPTURA: ..." normal (que guarda tal cual
 * el texto que escribió la persona en Telegram), esto va y LEE el correo
 * de verdad (asunto, remitente, cuerpo completo, no el snippet truncado de
 * Gmail) antes de capturarlo. Nace de una corrección real: al pedir
 * "CAPTURA la información del correo que llegó de X", el sistema guardaba
 * literalmente esa instrucción como si fuera el conocimiento, sin haber
 * leído el correo — así que después no había nada útil que consultar.
 *
 * También descarga y LEE los adjuntos (PDF/imagen), no solo el cuerpo —
 * segunda corrección real: un correo reenviado con una factura de vuelo
 * como adjunto (cuerpo = solo la cadena de reenvío, sin la factura en
 * texto) se capturaba sin ningún dato útil porque nadie miraba el adjunto.
 * Cada adjunto legible pasa por procesarDocumentoLocal (mismo criterio que
 * un archivo de Telegram o el correo automático): si es una factura/gasto,
 * se propone crear el gasto en Holded con su comprobante ya adjuntado; si
 * no, se propone archivar en Drive. Nunca escribe nada sin aprobación.
 */
export const capturarCorreoTool: ToolDefinition = {
  name: "capturar_correo",
  description:
    "Lee un correo real del buzón (asistente@wobagroup.com) y guarda su contenido completo (asunto, " +
    "remitente, cuerpo) en la base de conocimiento permanente — TAMBIÉN descarga y lee cualquier adjunto " +
    "(PDF/imagen): si es una factura/gasto, propone crearlo en Holded con el comprobante ya adjuntado " +
    "(botón de aprobación); si no, propone archivarlo en Drive. Úsala cuando pidan 'capturar', 'guardar', " +
    "'procesar' o 'que recuerdes' la información de un correo que llegó o que mencionan — incluyendo " +
    "facturas o comprobantes que llegaron como adjunto de correo, no solo texto. Nunca inventes ni " +
    "resumas el contenido de memoria, esta herramienta va a leer el correo real (y sus adjuntos). Si no " +
    "se especifica cuál correo, usa el más reciente de la bandeja de entrada.",
  input_schema: {
    type: "object",
    properties: {
      busqueda: {
        type: "string",
        description:
          "Términos para encontrar el correo correcto (remitente, asunto, tema) — puede ser lenguaje " +
          "natural o una consulta de Gmail (ej. 'from:proveedor@dominio.com', 'subject:factura'). Si no se " +
          "da o no se sabe cuál es, se omite y se toma el correo más reciente.",
      },
      empresas: {
        type: "array",
        items: { type: "string", enum: ["WOBA", "EWORKS", "Footprint", "General"] },
        description:
          "A qué empresa(s) del grupo corresponde esta información, si se puede determinar del contexto " +
          "de la conversación (quién lo pidió, de qué se habla). Si no es evidente, PREGÚNTALE al usuario " +
          "a qué empresa corresponde antes de llamar esta herramienta, en vez de adivinar — así la captura " +
          "queda correctamente etiquetada. Usa 'General' solo si de verdad aplica a las tres.",
      },
    },
  },
  handler: async (input, context) => {
    const busqueda = typeof input.busqueda === "string" ? input.busqueda.trim() : "";
    const empresas = Array.isArray(input.empresas) ? input.empresas.filter((e): e is string => typeof e === "string") : [];
    const query = busqueda ? `${busqueda} in:inbox` : "in:inbox";

    let ids: string[] = [];
    try {
      ids = await buscarMensajes(query, 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error buscando el correo: ${message}`;
    }

    if (ids.length === 0) {
      return busqueda
        ? `No encontré ningún correo que coincida con "${busqueda}" en la bandeja de entrada.`
        : "No encontré ningún correo en la bandeja de entrada.";
    }

    const [resumen, cuerpo] = await Promise.all([obtenerResumenCorreo(ids[0]), obtenerCuerpoCompletoCorreo(ids[0])]);

    const contenido = [`De: ${resumen.de}`, `Asunto: ${resumen.asunto}`, `Fecha: ${resumen.fecha}`, "", cuerpo].join("\n");

    await registrarCaptura(contenido, "correo entrante (capturado)", empresas);

    const empresasLabel = empresas.length > 0 ? ` (${empresas.join(", ")})` : "";
    const baseTexto =
      `Capturado el correo "${resumen.asunto}" de ${resumen.de}${empresasLabel} ` +
      `(${cuerpo.length} caracteres del cuerpo) — ya está en la base de conocimiento, disponible para ` +
      "futuras consultas.";

    if (resumen.adjuntos.length === 0) {
      return baseTexto;
    }

    if (context?.chatId === undefined) {
      return (
        `${baseTexto}\n\nEste correo tiene ${resumen.adjuntos.length} adjunto(s) (` +
        `${resumen.adjuntos.map((a) => a.filename).join(", ")}) pero no pude procesarlos automáticamente — ` +
        "vuelve a pedírmelo desde el chat normal."
      );
    }

    const resultadosAdjuntos: string[] = [];
    for (const adjunto of resumen.adjuntos) {
      try {
        const bytes = await descargarAdjunto(resumen.id, adjunto.attachmentId);
        await mkdir(UPLOADS_DIR, { recursive: true });
        const destino = join(UPLOADS_DIR, `${Date.now()}_${sanitizarNombre(adjunto.filename)}`);
        await writeFile(destino, bytes);

        const tipo = await procesarDocumentoLocal({
          chatId: context.chatId,
          rutaLocal: destino,
          nombreArchivoOriginal: adjunto.filename,
          mimeType: adjunto.mimeType,
          nombreParaClasificar: adjunto.filename,
          captionEfectivo: `Adjunto de correo capturado. De: ${resumen.de}. Asunto: ${resumen.asunto}.`,
          correoOrigen: {
            de: resumen.de,
            asunto: resumen.asunto || "(sin asunto)",
            threadId: resumen.threadId,
            messageIdHeader: resumen.messageIdHeader,
          },
        });

        resultadosAdjuntos.push(
          tipo === "gasto"
            ? `"${adjunto.filename}" — es una factura/gasto, ya te mandé la propuesta para crear el gasto en Holded con el comprobante adjunto`
            : `"${adjunto.filename}" — no es una factura, te mandé una propuesta para archivarlo en Drive`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[capturarCorreo] Error procesando adjunto "${adjunto.filename}":`, message);
        resultadosAdjuntos.push(`"${adjunto.filename}" — error al procesarlo: ${message}`);
      }
    }

    return `${baseTexto}\n\nAdemás, este correo tenía ${resumen.adjuntos.length} adjunto(s):\n${resultadosAdjuntos.map((r) => `- ${r}`).join("\n")}`;
  },
};

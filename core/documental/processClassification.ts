import { sendTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";
import { clasificarDocumento } from "./classifyFile";
import { crearPropuestaClasificacion, actualizarMessageIdClasificacion } from "./classificationStore";
import { guardarPendienteDesambiguacion } from "./disambiguationStore";

export interface ArchivoParaClasificar {
  chatId: number;
  rutaLocal: string;
  nombreArchivoOriginal: string;
  mimeType?: string;
  nombreParaClasificar: string;
  /** Caption original del usuario, o el texto ya enriquecido con su aclaración. */
  captionEfectivo?: string;
}

/**
 * Clasifica un archivo y decide qué hacer con el resultado:
 * - confianza baja: manda la pregunta de desambiguación y guarda un
 *   pendiente para conectar la próxima respuesta de texto del usuario con
 *   este mismo archivo (ver disambiguationStore + server.ts).
 * - confianza alta/media: crea la propuesta persistida y manda los botones
 *   "✅ Sí, archivar aquí" / "✏️ Elegir otra carpeta".
 * Compartida entre la recepción inicial del archivo y el flujo de
 * continuación cuando el usuario responde a una pregunta de desambiguación.
 */
export async function manejarClasificacion(archivo: ArchivoParaClasificar): Promise<void> {
  const clasificacion = await clasificarDocumento(archivo.nombreParaClasificar, archivo.captionEfectivo);

  if (clasificacion.confianza === "baja") {
    const pregunta = clasificacion.preguntaSiAmbiguo ?? "¿A qué empresa y carpeta pertenece este documento?";

    await guardarPendienteDesambiguacion({
      chatId: archivo.chatId,
      rutaLocal: archivo.rutaLocal,
      nombreArchivoOriginal: archivo.nombreArchivoOriginal,
      mimeType: archivo.mimeType,
      nombreParaClasificar: archivo.nombreParaClasificar,
      captionOriginal: archivo.captionEfectivo,
      preguntaFormulada: pregunta,
    });

    await sendTelegramMessage(archivo.chatId, pregunta);
    return;
  }

  const propuesta = await crearPropuestaClasificacion({
    nombreArchivoOriginal: archivo.nombreArchivoOriginal,
    rutaLocal: archivo.rutaLocal,
    mimeType: archivo.mimeType,
    clasificacion,
    chatId: archivo.chatId,
    messageId: 0,
  });

  const textoPropuesta = [
    `Este documento parece ser de **${clasificacion.empresa}**, tipo **${clasificacion.tipoDocumento}**.`,
    `¿Lo archivo en "${clasificacion.carpetaSugerida}"?`,
    ``,
    `(${clasificacion.razon})`,
  ].join("\n");

  const messageId = await sendTelegramMessageWithButtons(archivo.chatId, textoPropuesta, [
    [
      { text: "✅ Sí, archivar aquí", callback_data: `doc_confirm:${propuesta.id}` },
      { text: "✏️ Elegir otra carpeta", callback_data: `doc_reroute:${propuesta.id}` },
    ],
  ]);

  await actualizarMessageIdClasificacion(propuesta.id, messageId);
}

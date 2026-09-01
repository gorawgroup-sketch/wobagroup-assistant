import { sendTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";
import { clasificarDocumento, type ClasificacionDocumento } from "./classifyFile";
import { crearPropuestaClasificacion, actualizarMessageIdClasificacion } from "./classificationStore";
import { guardarPendienteDesambiguacion } from "./disambiguationStore";
import { transcribirParaCaptura } from "./transcribeForCapture";
import { iniciarSeleccionEmpresaCaptura } from "../knowledge/capturaEmpresaCallbackHandler";
import { ofrecerResponderCorreo } from "../gmail/emailCallbackHandler";

export interface ArchivoParaClasificar {
  chatId: number;
  rutaLocal: string;
  nombreArchivoOriginal: string;
  mimeType?: string;
  nombreParaClasificar: string;
  /** Caption original del usuario, o el texto ya enriquecido con su aclaración. */
  captionEfectivo?: string;
  /** Si vino de un correo, sus datos — para poder responderlo después de archivar (ver DocumentoLocalEntrante). */
  correoOrigen?: { de: string; asunto: string; threadId: string; messageIdHeader: string };
  /**
   * true cuando esta llamada es la continuación tras responder una pregunta
   * de desambiguación (ver server.ts) — evita ofrecer captura/respuesta una
   * SEGUNDA vez (ya se ofreció en la llamada original, antes de preguntar
   * la carpeta).
   */
  esContinuacionDesambiguacion?: boolean;
}

/**
 * Pedido explícito de Carlos, tras un caso real: un colaborador mandó por
 * correo una captura de pantalla con una lista de accesos activos diciendo
 * "para que lo memorices" — el sistema solo propuso archivarla en Drive,
 * sin reconocer que también pedían guardarla como conocimiento consultable
 * (CAPTURA) ni ofrecer responder el correo. Cuando el clasificador detecta
 * esa intención (pareceIntencionDeCaptura), además del flujo normal de
 * archivo (que sigue igual, sin saltarse la pregunta de dónde archivarlo):
 * 1) transcribe el contenido real del documento (Claude vision) y lo
 *    propone como CAPTURA — mismo flujo de selección de empresa ya
 *    existente, nunca se guarda sin el botón "✅ Confirmar y guardar".
 * 2) si vino de un correo, pregunta explícitamente si se responde — solo
 *    redacta el borrador si contesta que sí (ver ofrecerResponderCorreo).
 */
async function ofrecerCapturaYRespuesta(archivo: ArchivoParaClasificar, clasificacion: ClasificacionDocumento): Promise<void> {
  const transcripcion = await transcribirParaCaptura(archivo.rutaLocal, archivo.mimeType, archivo.captionEfectivo);

  const contenidoCaptura = [
    archivo.correoOrigen
      ? `De: ${archivo.correoOrigen.de}\nAsunto: ${archivo.correoOrigen.asunto}`
      : `Archivo: ${archivo.nombreArchivoOriginal}`,
    "",
    transcripcion,
  ].join("\n");

  await iniciarSeleccionEmpresaCaptura(archivo.chatId, contenidoCaptura, archivo.correoOrigen?.de ?? archivo.nombreArchivoOriginal);

  if (archivo.correoOrigen) {
    const contextoRespuesta =
      `Se recibió "${archivo.nombreArchivoOriginal}" (${clasificacion.tipoDocumento}) y se propuso guardar ` +
      `como conocimiento consultable (además de archivarlo en Drive si se aprueba). Contenido transcrito: ` +
      `${transcripcion}. Escribe una respuesta breve y cálida confirmando que quedó registrado/anotado.`;

    await ofrecerResponderCorreo(
      archivo.chatId,
      archivo.correoOrigen.de,
      archivo.correoOrigen.asunto,
      archivo.correoOrigen.threadId,
      archivo.correoOrigen.messageIdHeader,
      contextoRespuesta
    );
  }
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

  if (clasificacion.pareceIntencionDeCaptura && !archivo.esContinuacionDesambiguacion) {
    await ofrecerCapturaYRespuesta(archivo, clasificacion).catch((error) => {
      console.error("[processClassification] Error ofreciendo captura/respuesta de conocimiento (no crítico):", error);
    });
  }

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
      correoOrigen: archivo.correoOrigen,
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
    correoOrigen: archivo.correoOrigen,
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

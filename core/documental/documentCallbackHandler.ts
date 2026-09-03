import { answerCallbackQuery, editTelegramMessage, sendTelegramMessage } from "../telegram/client";
import { consumirPropuestaClasificacion, obtenerPropuestaClasificacion } from "./classificationStore";
import { archivarDocumentoEnDrive } from "./archiveFile";
import { guardarPendienteReglaClasificacion } from "./pendienteReglaClasificacionStore";
import { guardarPendienteAlertaDocumento } from "./pendienteAlertaDocumentoStore";
import { guardarPendienteReclasificacion } from "./pendienteReclasificacionStore";
import { transcribirParaCaptura } from "./transcribeForCapture";
import { iniciarSeleccionEmpresaCaptura } from "../knowledge/capturaEmpresaCallbackHandler";
import { avanzarColaCorreoSiActivo } from "../jobs/revisarCorreoNuevo";
import type { TelegramCallbackQuery } from "../telegram/types";

async function answerCallbackQuerySafe(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[documentCallbackHandler] No se pudo responder el callback_query (no crítico):", message);
  }
}

/**
 * Maneja los botones de clasificación de documentos (doc_confirm / doc_reroute).
 * "✅ Sí, archivar aquí" es el ÚNICO camino de código que dispara la subida
 * real a Drive (archivarDocumentoEnDrive) — nunca ocurre automáticamente.
 */
export async function handleDocumentCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  if (!data) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, id] = data.split(":");

  // "📚 Enseñar regla" / "⏰ Crear alerta" NO consumen la propuesta — solo la
  // leen. "✅ Sí, archivar aquí" / "✏️ Elegir otra carpeta" siguen
  // disponibles después de usar cualquiera de estos dos.
  if (accion === "doc_regla" || accion === "doc_alerta") {
    const propuestaPeek = await obtenerPropuestaClasificacion(id);
    if (!propuestaPeek) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible (expiró o ya fue procesada).");
      return;
    }

    await answerCallbackQuerySafe(callback.id);

    if (accion === "doc_regla") {
      await guardarPendienteReglaClasificacion({
        chatId: propuestaPeek.chatId,
        empresa: propuestaPeek.clasificacion.empresa,
        tipoDocumento: propuestaPeek.clasificacion.tipoDocumento,
        carpetaDestino: propuestaPeek.clasificacion.carpetaSugerida,
        nombreArchivoOriginal: propuestaPeek.nombreArchivoOriginal,
      });
      await sendTelegramMessage(
        propuestaPeek.chatId,
        `📚 Ok — respóndeme con la palabra o frase clave que identifica este tipo de documento (ej. un fragmento del nombre de archivo, del remitente, o del asunto). La próxima vez que un documento de ${propuestaPeek.clasificacion.empresa} coincida con eso, lo archivo directo en "${propuestaPeek.clasificacion.carpetaSugerida}" sin volver a preguntar.`
      );
    } else {
      await guardarPendienteAlertaDocumento({
        chatId: propuestaPeek.chatId,
        nombreArchivoOriginal: propuestaPeek.nombreArchivoOriginal,
        empresa: propuestaPeek.clasificacion.empresa,
        tipoDocumento: propuestaPeek.clasificacion.tipoDocumento,
      });
      await sendTelegramMessage(
        propuestaPeek.chatId,
        `⏰ Ok — respóndeme qué quieres que te recuerde sobre "${propuestaPeek.nombreArchivoOriginal}" y cuándo (ej. "avísame en 3 días si no se ha enviado a aduana", o "recuérdame el jueves confirmar con Alberto").`
      );
    }
    return;
  }

  // "🧠 Guardar como conocimiento" — tampoco consume la propuesta. Lee el
  // contenido real del documento (Claude vision, mismo transcriptor que ya
  // usa la captura automática cuando el clasificador detecta la intención
  // en el caption) y ofrece guardarlo con el flujo normal de CAPTURA
  // (botones de empresa, nunca se guarda sin "✅ Confirmar y guardar").
  if (accion === "doc_conocimiento") {
    const propuestaPeek = await obtenerPropuestaClasificacion(id);
    if (!propuestaPeek) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible (expiró o ya fue procesada).");
      return;
    }

    await answerCallbackQuerySafe(callback.id, "Leyendo el documento...");

    let capturaIniciada = false;
    try {
      const transcripcion = await transcribirParaCaptura(propuestaPeek.rutaLocal, propuestaPeek.mimeType, undefined);
      const contenido = [
        `Documento: ${propuestaPeek.nombreArchivoOriginal} (${propuestaPeek.clasificacion.empresa} — ${propuestaPeek.clasificacion.tipoDocumento})`,
        "",
        transcripcion,
      ].join("\n");
      const deColaCorreo = propuestaPeek.correoOrigen?.deColaCorreo === true;
      await iniciarSeleccionEmpresaCaptura(propuestaPeek.chatId, contenido, propuestaPeek.nombreArchivoOriginal, undefined, deColaCorreo);
      capturaIniciada = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[documentCallbackHandler] Error leyendo documento para guardar como conocimiento:", message);
      await sendTelegramMessage(
        propuestaPeek.chatId,
        `⚠️ No se pudo leer "${propuestaPeek.nombreArchivoOriginal}" para guardarlo como conocimiento: ${message}`
      );
    }

    // Bug real encontrado al verificar el sistema: esta rama nunca consumía
    // la propuesta de clasificación (a propósito, para poder "Guardar como
    // conocimiento" Y "Archivar aquí" para el mismo documento fuera de la
    // cola) — pero si el documento SÍ viene de la cola de revisión de
    // correo, eso deja abierta la posibilidad de que "Archivar aquí"/
    // "Elegir otra carpeta" TAMBIÉN se presionen después y avancen la cola
    // una segunda vez, sobre el correo que para entonces ya es otro (misma
    // contaminación cruzada que ya se corrigió en la auditoría, en un botón
    // que entonces no existía). Solo cuando la captura arrancó bien Y viene
    // de la cola: se consume la propuesta acá (esta captura YA es la
    // resolución completa de este adjunto) y se le quitan los botones al
    // mensaje original para que no quede uno viejo, clicable, sin efecto
    // real — en un try/catch aparte porque para este punto ya se le mandó
    // al usuario el mensaje real de captura, un fallo acá nunca debe
    // aparentar que la lectura del documento falló. Fuera de la cola
    // (documento subido por Telegram) se deja intacta — ahí sí tiene
    // sentido poder hacer ambas cosas.
    if (capturaIniciada && propuestaPeek.correoOrigen?.deColaCorreo) {
      try {
        await consumirPropuestaClasificacion(id);
        await editTelegramMessage(
          propuestaPeek.chatId,
          propuestaPeek.messageId,
          `🧠 Guardando "${propuestaPeek.nombreArchivoOriginal}" como conocimiento (elige la empresa abajo).`,
          []
        );
      } catch (error) {
        console.error("[documentCallbackHandler] No se pudo consumir la propuesta / limpiar botones tras guardar como conocimiento (no crítico):", error);
      }
    }
    return;
  }

  const propuesta = await consumirPropuestaClasificacion(id);

  if (!propuesta) {
    await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible (expiró o ya fue procesada).");
    return;
  }

  if (accion === "doc_reroute") {
    await answerCallbackQuerySafe(callback.id);
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `✏️ Ok — respóndeme con la empresa y carpeta correctas para "${propuesta.nombreArchivoOriginal}".`,
      []
    );

    // Bug real encontrado al verificar el sistema: esta rama borraba la
    // propuesta (consumirPropuestaClasificacion, arriba) y preguntaba la
    // empresa/carpeta correctas, pero no guardaba ese pendiente en ningún
    // lado — la respuesta de Carlos en texto libre no tenía ningún archivo
    // ni propuesta reales a los que aplicarse, así que "Elegir otra
    // carpeta" no completaba el archivado. Ahora se guarda lo necesario
    // (reclasificarDocumentoPendiente.ts, tool, retoma esto cuando el
    // usuario responda) para poder terminarlo de verdad.
    await guardarPendienteReclasificacion({
      chatId: propuesta.chatId,
      rutaLocal: propuesta.rutaLocal,
      nombreArchivoOriginal: propuesta.nombreArchivoOriginal,
      mimeType: propuesta.mimeType,
      tipoDocumentoOriginal: propuesta.clasificacion.tipoDocumento,
      correoOrigen: propuesta.correoOrigen,
    }).catch((error) => console.error("[documentCallbackHandler] Error guardando el pendiente de reclasificación:", error));

    // Ya NO avanza la cola acá — "elegir otra carpeta" todavía no resolvió
    // nada, solo pospuso la decisión hasta que reclasificarDocumentoPendiente
    // termine el archivado real con el dato correcto (ver ahí el avance,
    // gated igual que en cualquier otro punto terminal: solo si viene de la
    // cola Y el archivado tuvo éxito).
    return;
  }

  // doc_confirm
  await answerCallbackQuerySafe(callback.id, "Subiendo a Drive...");

  const resultado = await archivarDocumentoEnDrive(propuesta);

  if (resultado.ok) {
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `✅ Archivado — ${propuesta.nombreArchivoOriginal}\n${resultado.mensaje}\n\n🔗 ${resultado.webViewLink}`,
      []
    );
    // Solo avanza la cola si de verdad se archivó — si falló, mejor dejarlo
    // "activo" (visible, pendiente) que marcarlo leído sobre un documento
    // que en realidad nunca quedó guardado en ningún lado.
    if (propuesta.correoOrigen?.deColaCorreo) {
      await avanzarColaCorreoSiActivo(propuesta.chatId);
    }
  } else {
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `⚠️ No se pudo archivar — ${propuesta.nombreArchivoOriginal}\n\n${resultado.mensaje}`,
      []
    );
  }
}

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

    // Bug real encontrado en auditoría (2026-09-03): tras el fix de la
    // desambiguación que se cuelga en bucle, un documento que sigue sin
    // clasificarse con confianza también puede llegar hasta acá —
    // "Enseñar regla" guardaría una regla con empresa "desconocida"/carpeta
    // "(sin sugerencia)" como si fuera un dato real, y buscarReglaClasificacion
    // la aplica con confianza ALTA a cualquier documento futuro que coincida
    // con el criterio, sin volver a pasar por el clasificador — peor que no
    // aprender nada. Se rechaza acá en vez de dejar que se guarde basura.
    if (accion === "doc_regla" && (propuestaPeek.clasificacion.empresa === "desconocida" || propuestaPeek.clasificacion.carpetaSugerida === "(sin sugerencia)")) {
      await sendTelegramMessage(
        propuestaPeek.chatId,
        `📚 Todavía no tengo claro a qué empresa/carpeta pertenece "${propuestaPeek.nombreArchivoOriginal}" — no puedo aprender una regla sobre algo que ni yo mismo tengo identificado. Usa "✏️ Elegir otra carpeta" para decírmelo directo, y una vez archivado ahí sí puedes enseñarme la regla en otro documento parecido.`
      );
      return;
    }

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

    const deColaCorreo = propuestaPeek.correoOrigen?.deColaCorreo === true;

    await answerCallbackQuerySafe(callback.id, "Leyendo el documento...");

    // Bug real encontrado en la auditoría: esta rama nunca consumía la
    // propuesta de clasificación (a propósito, para poder "Guardar como
    // conocimiento" Y "Archivar aquí" para el mismo documento fuera de la
    // cola) — pero si el documento SÍ viene de la cola de revisión de
    // correo, eso dejaba "Archivar aquí"/"Elegir otra carpeta" clicables
    // durante TODA la transcripción (varios segundos, Claude vision), así
    // que un doble-tap podía resolver el mismo adjunto dos veces (avanzando
    // la cola dos veces, la segunda sobre un correo que ya no es este).
    // Ahora, si viene de la cola, se le quitan los botones al mensaje
    // original YA MISMO, antes de arrancar la transcripción — no elimina la
    // ventana de carrera al 100% (un tap que ya estaba en camino en
    // Telegram puede llegar de todas formas, mismo límite que ya existe en
    // cualquier botón de este sistema) pero la reduce de "varios segundos"
    // a la latencia de una sola llamada a Telegram. Fuera de la cola
    // (documento subido por Telegram) se deja intacta — ahí sí tiene
    // sentido poder guardar como conocimiento Y archivar el original.
    if (deColaCorreo) {
      await editTelegramMessage(
        propuestaPeek.chatId,
        propuestaPeek.messageId,
        `🧠 Leyendo "${propuestaPeek.nombreArchivoOriginal}" para guardarlo como conocimiento...`,
        []
      ).catch((error) => console.error("[documentCallbackHandler] No se pudo limpiar los botones del mensaje original (no crítico):", error));
    }

    let capturaIniciada = false;
    try {
      const transcripcion = await transcribirParaCaptura(propuestaPeek.rutaLocal, propuestaPeek.mimeType, undefined);
      const contenido = [
        `Documento: ${propuestaPeek.nombreArchivoOriginal} (${propuestaPeek.clasificacion.empresa} — ${propuestaPeek.clasificacion.tipoDocumento})`,
        "",
        transcripcion,
      ].join("\n");
      await iniciarSeleccionEmpresaCaptura(propuestaPeek.chatId, contenido, propuestaPeek.nombreArchivoOriginal, undefined, deColaCorreo);
      capturaIniciada = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[documentCallbackHandler] Error leyendo documento para guardar como conocimiento:", message);
      await sendTelegramMessage(
        propuestaPeek.chatId,
        `⚠️ No se pudo leer "${propuestaPeek.nombreArchivoOriginal}" para guardarlo como conocimiento: ${message}` +
          (deColaCorreo ? " Si igual quieres archivarlo en Drive, reenvíalo — esta propuesta ya no tiene botones activos." : "")
      );
    }

    // Se consume la propuesta de clasificación al final (best-effort — los
    // botones ya están fuera desde arriba, esto solo evita que quede una
    // fila huérfana en el Sheet) solo cuando la captura arrancó bien Y viene
    // de la cola — esta captura YA es la resolución completa de este
    // adjunto.
    if (capturaIniciada && deColaCorreo) {
      await consumirPropuestaClasificacion(id).catch((error) =>
        console.error("[documentCallbackHandler] No se pudo consumir la propuesta de clasificación tras guardar como conocimiento (no crítico):", error)
      );
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

    // Bug real encontrado al verificar el sistema: esta rama borraba la
    // propuesta (consumirPropuestaClasificacion, arriba) y preguntaba la
    // empresa/carpeta correctas, pero no guardaba ese pendiente en ningún
    // lado — la respuesta de Carlos en texto libre no tenía ningún archivo
    // ni propuesta reales a los que aplicarse, así que "Elegir otra
    // carpeta" no completaba el archivado. Ahora se guarda lo necesario
    // (reclasificarDocumentoPendiente.ts, tool, retoma esto cuando el
    // usuario responda) para poder terminarlo de verdad — y se guarda ANTES
    // de decirle a Carlos que responda (no después): si el guardado falla,
    // hace falta saberlo YA, en vez de pedirle una respuesta que no va a
    // tener dónde aterrizar (bug real encontrado en la auditoría — el orden
    // original notificaba primero).
    const guardado = await guardarPendienteReclasificacion({
      chatId: propuesta.chatId,
      rutaLocal: propuesta.rutaLocal,
      nombreArchivoOriginal: propuesta.nombreArchivoOriginal,
      mimeType: propuesta.mimeType,
      tipoDocumentoOriginal: propuesta.clasificacion.tipoDocumento,
      correoOrigen: propuesta.correoOrigen,
    })
      .then(() => true)
      .catch((error) => {
        console.error("[documentCallbackHandler] Error guardando el pendiente de reclasificación:", error);
        return false;
      });

    if (!guardado) {
      // Nada quedó pendiente de verdad (la propuesta original ya se borró
      // arriba) — dejarlo "activo" solo bloquearía el resto de la cola
      // esperando una respuesta que nunca va a completar nada. Se avisa con
      // claridad y se avanza, igual que cualquier otro error irreversible
      // de este flujo (mismo criterio que preguntarSiConciliar en
      // gastoCallbackHandler.ts).
      await editTelegramMessage(
        propuesta.chatId,
        propuesta.messageId,
        `⚠️ No pude preparar "${propuesta.nombreArchivoOriginal}" para elegir otra carpeta (error guardando el pendiente). Reenvía el archivo si todavía quieres archivarlo.`,
        []
      );
      if (propuesta.correoOrigen?.deColaCorreo) {
        await avanzarColaCorreoSiActivo(propuesta.chatId);
      }
      return;
    }

    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `✏️ Ok — respóndeme con la empresa y carpeta correctas para "${propuesta.nombreArchivoOriginal}".`,
      []
    );

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

import { unlink } from "node:fs/promises";
import { answerCallbackQuery, editTelegramMessage, sendTelegramMessage } from "../telegram/client";
import { consumirPropuestaClasificacion, obtenerPropuestaClasificacion } from "./classificationStore";
import { archivarDocumentoEnDrive } from "./archiveFile";
import { guardarPendienteReglaClasificacion } from "./pendienteReglaClasificacionStore";
import { guardarPendienteAlertaDocumento } from "./pendienteAlertaDocumentoStore";
import { guardarPendienteReclasificacion } from "./pendienteReclasificacionStore";
import { consumirPendienteDesambiguacionPorId, obtenerPendienteDesambiguacionPorChat } from "./disambiguationStore";
import { registrarDocumentoArchivadoDesdeCorreo } from "./documentoArchivadoPorCorreoStore";
import { transcribirParaCaptura } from "./transcribeForCapture";
import { iniciarSeleccionEmpresaCaptura } from "../knowledge/capturaEmpresaCallbackHandler";
import { avanzarColaCorreoSiActivo } from "../jobs/revisarCorreoNuevo";
import { extraerDatosFactura } from "./extractInvoiceData";
import { MIMES_LEGIBLES_COMO_FACTURA, procesarEmlComoGastoForzado } from "./procesarDocumentoLocal";
import { esArchivoEml } from "./parseEml";
import { procesarGastoEntrante } from "../gastos/procesarGastoEntrante";
import { ofrecerResponderCorreo } from "../gmail/emailCallbackHandler";
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
 * Registra que este adjunto de correo YA se resolvió (archivado con éxito, o descartado a propósito
 * — ambas son decisiones finales legítimas) — para que un reproceso futuro del mismo correo
 * (automático o vía revisar_correo_puntual) lo salte en vez de volver a descargarlo y clasificarlo
 * desde cero (ver documentoArchivadoPorCorreoStore.ts). Deliberadamente se llama SOLO en los puntos
 * de resolución REAL, nunca al proponer — mismo criterio ya usado para gastos
 * (registrarGastoDesdeCorreo se llama tras la creación real en Holded, nunca al proponer). Sin
 * mensajeIdGmail/partId (documento no venía de un correo) no hay nada que registrar. Usa `partId`,
 * no `attachmentIdGmail` — ver AdjuntoCorreo.partId en gmail/client.ts: attachmentIdGmail cambia en
 * cada lectura del correo, así que registrar con ese valor nunca coincide en un reproceso futuro.
 */
async function registrarResolucionDesdeCorreo(correoOrigen: { mensajeIdGmail?: string; partId?: string } | undefined): Promise<void> {
  if (!correoOrigen?.mensajeIdGmail || !correoOrigen?.partId) return;
  await registrarDocumentoArchivadoDesdeCorreo({
    mensajeIdGmail: correoOrigen.mensajeIdGmail,
    attachmentId: correoOrigen.partId,
  }).catch((error) => console.error("[documentCallbackHandler] Error registrando adjunto resuelto (no crítico):", error));
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

  // "✍️ Generar respuesta al correo" — tampoco consume la propuesta (mismo criterio que
  // doc_regla/doc_alerta). Pedido explícito de Carlos: para un correo con adjuntos que NO es un
  // gasto, debe poder pedir una respuesta al remitente sin salir del flujo de archivo — reutiliza
  // ofrecerResponderCorreo tal cual (mismo mecanismo de aprobación con botones "Enviar así/Editar/No
  // enviar" que ya usa el resto del sistema, nunca envía nada por sí sola).
  if (accion === "doc_responder") {
    const propuestaPeek = await obtenerPropuestaClasificacion(id);
    if (!propuestaPeek) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible (expiró o ya fue procesada).");
      return;
    }
    if (!propuestaPeek.correoOrigen) {
      await answerCallbackQuerySafe(callback.id, "Este documento no vino de un correo — no hay nada que responder.");
      return;
    }

    await answerCallbackQuerySafe(callback.id);

    const contexto =
      `Se recibió "${propuestaPeek.nombreArchivoOriginal}" (${propuestaPeek.clasificacion.tipoDocumento}, ` +
      `${propuestaPeek.clasificacion.empresa}) — ${propuestaPeek.clasificacion.razon} Redacta una respuesta breve ` +
      `y profesional acorde a este documento (ej. acuse de recibo, confirmación de que quedó archivado, o lo que ` +
      `el contexto sugiera).`;

    await ofrecerResponderCorreo(
      propuestaPeek.chatId,
      propuestaPeek.correoOrigen.de,
      propuestaPeek.correoOrigen.asunto,
      propuestaPeek.correoOrigen.threadId,
      propuestaPeek.correoOrigen.messageIdHeader,
      contexto
    );
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

  // "💰 Es un gasto — procesarlo en Holded" — hallazgo real de auditoría (Footprint, factura Hotel
  // Columbus/Costa Rica, 2026-09-16): el clasificador de documentos (solo texto) reconoció por
  // contexto que esto es un gasto de viaje real, pero solo podía ofrecer archivarlo — no había forma
  // de redirigirlo al flujo real de gasto. Relee el documento con extraerDatosFactura (la misma
  // lectura con visión que procesarDocumentoLocal.ts usa siempre) pero, a diferencia del camino
  // automático, el usuario YA confirmó que es un gasto — se fuerza esFacturaOGasto=true y se usan los
  // demás datos que sí haya logrado leer (proveedor/monto/fecha/líneas), aunque el modelo haya dudado
  // del tipo de documento. No consume la propuesta de clasificación (igual que "🧠 Guardar como
  // conocimiento") — "Sí, archivar aquí" sigue disponible después, por si también quiere archivarlo.
  if (accion === "doc_esgasto") {
    const propuestaPeek = await obtenerPropuestaClasificacion(id);
    if (!propuestaPeek) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible (expiró o ya fue procesada).");
      return;
    }

    // Hallazgo real de auditoría (2026-09-18, caso real Footprint, hotel Scandic Holmenkollen Park):
    // este botón rechazaba cualquier .eml (correo reenviado como archivo) porque solo sabía leer
    // PDF/imagen — justo el caso que motivó agregar soporte de lectura de .eml el mismo día, sin
    // conectar ambas funciones. Un .eml se procesa por procesarEmlComoGastoForzado en vez de
    // extraerDatosFactura.
    const esEml = esArchivoEml(propuestaPeek.mimeType, propuestaPeek.nombreArchivoOriginal);
    if (!esEml && (!propuestaPeek.mimeType || !MIMES_LEGIBLES_COMO_FACTURA.includes(propuestaPeek.mimeType))) {
      await answerCallbackQuerySafe(callback.id);
      await sendTelegramMessage(
        propuestaPeek.chatId,
        `⚠️ "${propuestaPeek.nombreArchivoOriginal}" no es un PDF, una imagen ni un correo reenviado (.eml) — no lo puedo leer como comprobante de gasto directamente. Reenvíalo como PDF/imagen si quieres que lo procese como gasto.`
      );
      return;
    }

    const deColaCorreo = propuestaPeek.correoOrigen?.deColaCorreo === true;
    await answerCallbackQuerySafe(callback.id, "Leyendo el comprobante...");

    // Mismo motivo que en "🧠 Guardar como conocimiento": si viene de la cola, se le quitan los
    // botones al mensaje original YA MISMO (antes de la relectura, que tarda varios segundos) para
    // reducir la ventana de un doble-tap que resuelva el mismo adjunto dos veces.
    if (deColaCorreo) {
      await editTelegramMessage(
        propuestaPeek.chatId,
        propuestaPeek.messageId,
        `💰 Procesando "${propuestaPeek.nombreArchivoOriginal}" como gasto...`,
        []
      ).catch((error) => console.error("[documentCallbackHandler] No se pudo limpiar los botones del mensaje original (no crítico):", error));
    }

    const captionReconstruido = propuestaPeek.correoOrigen
      ? `Adjunto de correo. De: ${propuestaPeek.correoOrigen.de}. Asunto: ${propuestaPeek.correoOrigen.asunto}.`
      : undefined;

    let gastoIniciado = false;
    try {
      if (esEml) {
        const resultadoEml = await procesarEmlComoGastoForzado({
          chatId: propuestaPeek.chatId,
          rutaLocal: propuestaPeek.rutaLocal,
          nombreArchivoOriginal: propuestaPeek.nombreArchivoOriginal,
          mimeType: propuestaPeek.mimeType,
          nombreParaClasificar: propuestaPeek.nombreArchivoOriginal,
          captionEfectivo: captionReconstruido,
          correoOrigen: propuestaPeek.correoOrigen,
        });
        if (resultadoEml.error) {
          throw new Error(resultadoEml.error);
        }
        gastoIniciado = resultadoEml.resultado !== "gasto_pendiente_datos";
      } else {
        const datosFactura = await extraerDatosFactura(
          propuestaPeek.rutaLocal,
          propuestaPeek.mimeType,
          captionReconstruido,
          propuestaPeek.nombreArchivoOriginal
        );
        const resultado = await procesarGastoEntrante({
          chatId: propuestaPeek.chatId,
          rutaLocal: propuestaPeek.rutaLocal,
          nombreArchivoOriginal: propuestaPeek.nombreArchivoOriginal,
          mimeType: propuestaPeek.mimeType,
          // El usuario ya confirmó con este botón que SÍ es un gasto — se fuerza el campo aunque la
          // relectura vuelva a dudarlo, pero se conservan los demás datos que sí logró leer.
          datos: { ...datosFactura, esFacturaOGasto: true },
          deColaCorreo,
          origenAdjuntoGmail:
            propuestaPeek.correoOrigen?.mensajeIdGmail && propuestaPeek.correoOrigen?.attachmentIdGmail
              ? {
                  mensajeIdGmail: propuestaPeek.correoOrigen.mensajeIdGmail,
                  attachmentIdGmail: propuestaPeek.correoOrigen.attachmentIdGmail,
                  partId: propuestaPeek.correoOrigen.partId,
                }
              : undefined,
          correoOrigen: propuestaPeek.correoOrigen
            ? {
                de: propuestaPeek.correoOrigen.de,
                asunto: propuestaPeek.correoOrigen.asunto,
                threadId: propuestaPeek.correoOrigen.threadId,
                messageIdHeader: propuestaPeek.correoOrigen.messageIdHeader,
                mensajeIdGmail: propuestaPeek.correoOrigen.mensajeIdGmail,
              }
            : undefined,
        });
        gastoIniciado = resultado !== "pendiente_datos";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[documentCallbackHandler] Error procesando documento como gasto:", message);
      await sendTelegramMessage(
        propuestaPeek.chatId,
        `⚠️ No se pudo procesar "${propuestaPeek.nombreArchivoOriginal}" como gasto: ${message}` +
          (deColaCorreo ? " Si igual quieres archivarlo en Drive, reenvíalo — esta propuesta ya no tiene botones activos." : "")
      );
    }

    // Igual criterio que "🧠 Guardar como conocimiento": solo se consume (y avanza la cola) cuando el
    // gasto realmente arrancó y venía de la cola — procesarGastoEntrante ya deja su propio pendiente
    // (gastoPendienteDatosStore) cuando faltan datos, así que "pendiente_datos" NO avanza la cola acá.
    if (gastoIniciado && deColaCorreo) {
      await consumirPropuestaClasificacion(id).catch((error) =>
        console.error("[documentCallbackHandler] No se pudo consumir la propuesta de clasificación tras procesar como gasto (no crítico):", error)
      );
      await avanzarColaCorreoSiActivo(propuestaPeek.chatId);
    }
    return;
  }

  const propuesta = await obtenerPropuestaClasificacion(id);

  if (!propuesta) {
    await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible (expiró o ya fue procesada).");
    return;
  }

  // Pedido explícito de Carlos: siempre debe haber una forma real de decir
  // "no hagas nada con esto" — antes no existía ningún botón de descarte
  // para documentos (a diferencia de los correos sin adjunto, que sí tienen
  // "❌ Descartar"). Borra el archivo temporal local (best-effort — si ya no
  // está, no importa) y avanza la cola si venía de ahí, igual que cualquier
  // otro punto terminal de este flujo.
  if (accion === "doc_descartar") {
    await answerCallbackQuerySafe(callback.id);
    await consumirPropuestaClasificacion(id);
    await registrarResolucionDesdeCorreo(propuesta.correoOrigen);
    await unlink(propuesta.rutaLocal).catch(() => {});
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `❌ Descartado — "${propuesta.nombreArchivoOriginal}" (no se archivó ni se guardó nada).`,
      []
    );
    if (propuesta.correoOrigen?.deColaCorreo) {
      await avanzarColaCorreoSiActivo(propuesta.chatId);
    }
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
      id: propuesta.id,
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
      // La propuesta original aún existe porque ahora solo se consume tras
      // persistir el siguiente estado. El usuario puede volver a intentarlo.
      await editTelegramMessage(
        propuesta.chatId,
        propuesta.messageId,
        `⚠️ No pude preparar "${propuesta.nombreArchivoOriginal}" para elegir otra carpeta. La propuesta sigue pendiente; vuelve a pulsar el botón en unos segundos.`,
        [[{ text: "✏️ Reintentar elegir carpeta", callback_data: `doc_reroute:${propuesta.id}:${Date.now().toString(36)}` }]]
      );
      return;
    }

    await consumirPropuestaClasificacion(id).catch((error) =>
      console.error("[documentCallbackHandler] No se pudo cerrar la propuesta tras guardar la reclasificación:", error instanceof Error ? error.name : "Error")
    );

    // Hallazgo real de auditoría: este mensaje pedía la empresa/carpeta a ciegas, sin decir que se
    // puede pedir ver las carpetas que ya existen, crear una nueva, o simplemente descartarlo —
    // Carlos no tiene por qué saber de memoria la estructura real de Drive. Las tres ya son posibles
    // (listar_carpetas_drive, crearCarpetaSiNoExiste y descartar_documento_pendiente), solo hacía
    // falta decirlo.
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `✏️ Ok — dime la empresa y carpeta correctas para "${propuesta.nombreArchivoOriginal}" (ej. "EWORKS, en Colaboradores/Alejandra"). ` +
        `Si no sabes qué carpetas existen, dime "muéstrame las carpetas de [empresa]" y te las listo. ` +
        `Si la carpeta que quieres no existe todavía, dime que la cree ("créala") y la armo yo. ` +
        `Si en realidad no hace falta archivarlo, dime "descártalo".`,
      []
    );

    // Ya NO avanza la cola acá — "elegir otra carpeta" todavía no resolvió
    // nada, solo pospuso la decisión hasta que reclasificarDocumentoPendiente
    // termine el archivado real con el dato correcto (ver ahí el avance,
    // gated igual que en cualquier otro punto terminal: solo si viene de la
    // cola Y el archivado tuvo éxito).
    return;
  }

  // doc_confirm / doc_retry
  if (accion !== "doc_confirm" && accion !== "doc_retry") {
    await answerCallbackQuerySafe(callback.id, "Acción de documento no reconocida.");
    return;
  }
  await answerCallbackQuerySafe(callback.id, "Subiendo a Drive...");

  const resultado = await archivarDocumentoEnDrive(propuesta);

  if (resultado.ok) {
    await consumirPropuestaClasificacion(id).catch((error) =>
      console.error("[documentCallbackHandler] No se pudo cerrar la propuesta después de verificar Drive:", error instanceof Error ? error.name : "Error")
    );
    await registrarResolucionDesdeCorreo(propuesta.correoOrigen);
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
      `⚠️ No se pudo confirmar el archivado — ${propuesta.nombreArchivoOriginal}\n\n${resultado.mensaje}\n\nLa propuesta sigue disponible. Puedes reintentar; si Drive ya lo recibió, WOBI solo lo verificará y no volverá a subirlo.`,
      [
        [{ text: "🔄 Verificar / reintentar", callback_data: `doc_retry:${propuesta.id}:${Date.now().toString(36)}` }],
        [
          { text: "✏️ Elegir otra carpeta", callback_data: `doc_reroute:${propuesta.id}:${Date.now().toString(36)}` },
          { text: "❌ Descartar", callback_data: `doc_descartar:${propuesta.id}:${Date.now().toString(36)}` },
        ],
      ]
    );
  }
}

/**
 * Maneja los botones de la pregunta de desambiguación (ver processClassification.ts) — pedido
 * explícito de Carlos: siempre debe existir una forma de decir "no hagas nada con esto" en vez de
 * verse forzado a responder con empresa/carpeta o quedar atrapado. PendienteDesambiguacion no guarda
 * messageId (a diferencia de las propuestas de clasificación), así que las confirmaciones se mandan
 * como mensaje nuevo en vez de editar el original.
 *
 * Caso real (2026-09-07): con varios adjuntos ambiguos del mismo correo, cada uno manda su propia
 * pregunta — resuelve SIEMPRE por id, nunca comparando contra "la" pendiente del chat, porque ahora
 * pueden coexistir varias a la vez (ver disambiguationStore.ts) y cada botón debe poder resolverse
 * en cualquier orden.
 *
 * Segundo hallazgo real (Footprint, Modelo 303/349, 2026-09-17): "❌ Descartar" era la ÚNICA acción
 * con botón acá — un documento ambiguo tenía MENOS alternativas reales que uno bien clasificado. Los
 * 3 botones nuevos (guardar conocimiento/crear alerta/generar respuesta) NO consumen la pregunta —
 * mismo criterio que sus equivalentes doc_conocimiento/doc_alerta/doc_responder — así que responder
 * por texto la empresa/carpeta, o "❌ Descartar" después, siguen disponibles.
 */
export async function handleDesambiguacionCallback(callback: TelegramCallbackQuery): Promise<void> {
  const chatId = callback.message?.chat.id;
  if (chatId === undefined) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, idBoton, indiceCarpetaRaw] = (callback.data ?? "").split(":");

  // "📁 <carpeta>" — botón directo por cada carpeta candidata que el clasificador ya identificó como
  // real (ver ClasificacionDocumento.carpetasCandidatas / processClassification.ts). A diferencia de
  // los 3 de arriba, este SÍ consume la pregunta — archiva de una vez, igual que "✅ Sí, archivar
  // aquí" en el flujo de confianza alta/media, sin volver a pasar por el clasificador de texto.
  if (accion === "desamb_elegir") {
    const pendiente = idBoton ? await consumirPendienteDesambiguacionPorId(idBoton, chatId) : undefined;
    if (!pendiente) {
      await answerCallbackQuerySafe(callback.id, "Esta pregunta ya no está disponible (expiró o ya se respondió).");
      return;
    }
    const indice = Number(indiceCarpetaRaw);
    const carpeta = pendiente.empresa && pendiente.carpetasCandidatas ? pendiente.carpetasCandidatas[indice] : undefined;
    if (!pendiente.empresa || !carpeta) {
      await answerCallbackQuerySafe(callback.id, "Esa opción ya no es válida.");
      return;
    }

    await answerCallbackQuerySafe(callback.id, "Subiendo a Drive...");

    const propuestaSintetica = {
      id: pendiente.id,
      nombreArchivoOriginal: pendiente.nombreArchivoOriginal,
      rutaLocal: pendiente.rutaLocal,
      mimeType: pendiente.mimeType,
      clasificacion: {
        empresa: pendiente.empresa as "WOBA" | "EWORKS" | "Footprint",
        tipoDocumento: pendiente.nombreParaClasificar,
        carpetaSugerida: carpeta,
        confianza: "alta" as const,
        razon: "Elegida por botón entre las carpetas candidatas.",
      },
      chatId,
      messageId: 0,
      creadoEn: pendiente.creadoEn,
      correoOrigen: pendiente.correoOrigen,
    };

    const resultado = await archivarDocumentoEnDrive(propuestaSintetica);

    if (resultado.ok) {
      await registrarResolucionDesdeCorreo(pendiente.correoOrigen);
      await sendTelegramMessage(chatId, `✅ Archivado — ${pendiente.nombreArchivoOriginal}\n${resultado.mensaje}\n\n🔗 ${resultado.webViewLink}`);
      if (pendiente.correoOrigen?.deColaCorreo) {
        await avanzarColaCorreoSiActivo(chatId);
      }
    } else {
      await sendTelegramMessage(
        chatId,
        `⚠️ No se pudo archivar "${pendiente.nombreArchivoOriginal}" en "${carpeta}": ${resultado.mensaje} La copia local no se borró — dime la empresa/carpeta de nuevo, o reenvía el archivo.`
      );
    }
    return;
  }

  // "💰 Es un gasto — procesarlo en Holded" — pedido explícito de Carlos (mismo caso Footprint,
  // hotel APECS Noruega, 2026-09-18): "a todos los botones que me des, siempre... inclúyele un botón
  // que dice procesar como gasto. De esa manera nos aseguramos que si lo procesas mal, lo podemos
  // reencaminar inmediatamente" — este botón faltaba por completo en la pregunta de desambiguación
  // (solo existía en el flujo de confianza alta/media, doc_esgasto), así que un documento realmente
  // ambiguo tenía MENOS forma de corregirse hacia gasto que uno bien clasificado. Mismo mecanismo que
  // doc_esgasto: relee con extraerDatosFactura, fuerza esFacturaOGasto=true. No consume la pregunta
  // de desambiguación salvo que el gasto arranque bien Y venga de la cola (evita avanzar la cola dos
  // veces si después también se resuelve "a qué carpeta" — mismo criterio que doc_esgasto con
  // consumirPropuestaClasificacion).
  if (accion === "desamb_esgasto") {
    const todas = idBoton ? await obtenerPendienteDesambiguacionPorChat(chatId).catch(() => []) : [];
    const pendientePeek = todas.find((p) => p.id === idBoton);
    if (!pendientePeek) {
      await answerCallbackQuerySafe(callback.id, "Esta pregunta ya no está disponible (expiró o ya se respondió).");
      return;
    }

    // Hallazgo real de auditoría (2026-09-18): igual que doc_esgasto, ahora también reconoce un .eml
    // (correo reenviado como archivo) — antes lo rechazaba siempre, justo el caso real (hotel Scandic
    // Holmenkollen Park) que motivó agregar soporte de lectura de .eml el mismo día.
    const esEml = esArchivoEml(pendientePeek.mimeType, pendientePeek.nombreArchivoOriginal);
    if (!esEml && (!pendientePeek.mimeType || !MIMES_LEGIBLES_COMO_FACTURA.includes(pendientePeek.mimeType))) {
      await answerCallbackQuerySafe(callback.id);
      await sendTelegramMessage(
        chatId,
        `⚠️ "${pendientePeek.nombreArchivoOriginal}" no es un PDF, una imagen ni un correo reenviado (.eml) — no lo puedo leer como comprobante de gasto directamente. Reenvíalo como PDF/imagen si quieres que lo procese como gasto.`
      );
      return;
    }

    // Hallazgo real de auditoría (2026-09-18): PendienteDesambiguacion no guarda messageId, así que a
    // diferencia de doc_esgasto no se pueden limpiar los botones del mensaje original antes de la
    // relectura lenta. Consumir el registro mismo, ACÁ, logra el mismo efecto: si "desamb_elegir" se
    // pulsa mientras esto sigue en curso, su propio consumo no encuentra nada y avisa que ya se
    // resolvió, en vez de avanzar la cola una segunda vez con datos obsoletos.
    const pendiente = await consumirPendienteDesambiguacionPorId(pendientePeek.id, chatId).catch(() => undefined);
    if (!pendiente) {
      await answerCallbackQuerySafe(callback.id, "Esta pregunta ya no está disponible (expiró, ya se respondió, o se resolvió con otro botón).");
      return;
    }

    const deColaCorreo = pendiente.correoOrigen?.deColaCorreo === true;
    await answerCallbackQuerySafe(callback.id, "Leyendo el comprobante...");

    const captionReconstruido = pendiente.correoOrigen
      ? `Adjunto de correo. De: ${pendiente.correoOrigen.de}. Asunto: ${pendiente.correoOrigen.asunto}.`
      : undefined;

    let gastoIniciado = false;
    try {
      if (esEml) {
        const resultadoEml = await procesarEmlComoGastoForzado({
          chatId,
          rutaLocal: pendiente.rutaLocal,
          nombreArchivoOriginal: pendiente.nombreArchivoOriginal,
          mimeType: pendiente.mimeType,
          nombreParaClasificar: pendiente.nombreArchivoOriginal,
          captionEfectivo: captionReconstruido,
          correoOrigen: pendiente.correoOrigen,
        });
        if (resultadoEml.error) {
          throw new Error(resultadoEml.error);
        }
        gastoIniciado = resultadoEml.resultado !== "gasto_pendiente_datos";
      } else {
        const datosFactura = await extraerDatosFactura(
          pendiente.rutaLocal,
          pendiente.mimeType,
          captionReconstruido,
          pendiente.nombreArchivoOriginal
        );
        const resultado = await procesarGastoEntrante({
          chatId,
          rutaLocal: pendiente.rutaLocal,
          nombreArchivoOriginal: pendiente.nombreArchivoOriginal,
          mimeType: pendiente.mimeType,
          datos: { ...datosFactura, esFacturaOGasto: true },
          deColaCorreo,
          origenAdjuntoGmail:
            pendiente.correoOrigen?.mensajeIdGmail && pendiente.correoOrigen?.attachmentIdGmail
              ? {
                  mensajeIdGmail: pendiente.correoOrigen.mensajeIdGmail,
                  attachmentIdGmail: pendiente.correoOrigen.attachmentIdGmail,
                  partId: pendiente.correoOrigen.partId,
                }
              : undefined,
          correoOrigen: pendiente.correoOrigen
            ? {
                de: pendiente.correoOrigen.de,
                asunto: pendiente.correoOrigen.asunto,
                threadId: pendiente.correoOrigen.threadId,
                messageIdHeader: pendiente.correoOrigen.messageIdHeader,
                mensajeIdGmail: pendiente.correoOrigen.mensajeIdGmail,
              }
            : undefined,
        });
        gastoIniciado = resultado !== "pendiente_datos";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[documentCallbackHandler] Error procesando documento ambiguo como gasto:", message);
      await sendTelegramMessage(chatId, `⚠️ No se pudo procesar "${pendiente.nombreArchivoOriginal}" como gasto: ${message}`);
    }

    // El registro ya se consumió arriba (antes de la relectura) — acá solo falta avanzar la cola si
    // el gasto realmente arrancó y venía de ahí.
    if (gastoIniciado && deColaCorreo) {
      await avanzarColaCorreoSiActivo(chatId);
    }
    return;
  }

  if (accion === "desamb_conocimiento" || accion === "desamb_alerta" || accion === "desamb_responder") {
    const todas = idBoton ? await obtenerPendienteDesambiguacionPorChat(chatId).catch(() => []) : [];
    const pendientePeek = todas.find((p) => p.id === idBoton);
    if (!pendientePeek) {
      await answerCallbackQuerySafe(callback.id, "Esta pregunta ya no está disponible (expiró o ya se respondió).");
      return;
    }

    await answerCallbackQuerySafe(callback.id);

    if (accion === "desamb_alerta") {
      await guardarPendienteAlertaDocumento({
        chatId,
        nombreArchivoOriginal: pendientePeek.nombreArchivoOriginal,
        empresa: "desconocida",
        tipoDocumento: pendientePeek.preguntaFormulada,
      });
      await sendTelegramMessage(
        chatId,
        `⏰ Ok — respóndeme qué quieres que te recuerde sobre "${pendientePeek.nombreArchivoOriginal}" y cuándo (ej. "avísame en 3 días si no se ha enviado a aduana").`
      );
      return;
    }

    if (accion === "desamb_responder") {
      if (!pendientePeek.correoOrigen) {
        await sendTelegramMessage(chatId, "Este documento no vino de un correo — no hay nada que responder.");
        return;
      }
      await ofrecerResponderCorreo(
        chatId,
        pendientePeek.correoOrigen.de,
        pendientePeek.correoOrigen.asunto,
        pendientePeek.correoOrigen.threadId,
        pendientePeek.correoOrigen.messageIdHeader,
        `Se recibió "${pendientePeek.nombreArchivoOriginal}", todavía sin identificar con certeza a qué empresa/carpeta pertenece. Redacta una respuesta breve y profesional (ej. acuse de recibo).`
      );
      return;
    }

    // desamb_conocimiento
    try {
      const transcripcion = await transcribirParaCaptura(pendientePeek.rutaLocal, pendientePeek.mimeType, pendientePeek.captionOriginal);
      const contenido = [
        pendientePeek.correoOrigen
          ? `De: ${pendientePeek.correoOrigen.de}\nAsunto: ${pendientePeek.correoOrigen.asunto}`
          : `Archivo: ${pendientePeek.nombreArchivoOriginal}`,
        "",
        transcripcion,
      ].join("\n");
      await iniciarSeleccionEmpresaCaptura(chatId, contenido, pendientePeek.nombreArchivoOriginal, undefined, pendientePeek.correoOrigen?.deColaCorreo === true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[documentCallbackHandler] Error leyendo documento ambiguo para guardar como conocimiento:", message);
      await sendTelegramMessage(chatId, `⚠️ No se pudo leer "${pendientePeek.nombreArchivoOriginal}" para guardarlo como conocimiento: ${message}`);
    }
    return;
  }

  await answerCallbackQuerySafe(callback.id);

  const pendiente = idBoton ? await consumirPendienteDesambiguacionPorId(idBoton, chatId) : undefined;
  if (!pendiente) {
    // Pedido explícito de Carlos: los avisos siempre deben decir claramente qué hacer, nunca dejar
    // duda — si esta pregunta ya no está pero quedan otras pendientes para este chat, lo dice, en vez
    // de solo "ya no está disponible" sin ninguna pista de qué sigue.
    const otras = await obtenerPendienteDesambiguacionPorChat(chatId).catch(() => []);
    const aviso =
      otras.length > 0
        ? `Esta pregunta ya no está disponible (expiró o ya se respondió) — todavía tienes ${otras.length === 1 ? "una pregunta pendiente" : `${otras.length} preguntas pendientes`} sin responder, arriba en el chat.`
        : "Esta pregunta ya no está disponible (expiró o ya se respondió).";
    await sendTelegramMessage(chatId, aviso);
    return;
  }

  await unlink(pendiente.rutaLocal).catch(() => {});
  await registrarResolucionDesdeCorreo(pendiente.correoOrigen);
  await sendTelegramMessage(chatId, `❌ Descartado — "${pendiente.nombreArchivoOriginal}" (no se archivó ni se guardó nada).`);

  if (pendiente.correoOrigen?.deColaCorreo) {
    await avanzarColaCorreoSiActivo(chatId);
  }
}

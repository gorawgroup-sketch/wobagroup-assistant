import { solicitarRespuestaCarpeta } from "./respuestaCarpeta";
import { unlink } from "node:fs/promises";
import { answerCallbackQuery, editTelegramMessage, sendTelegramMessage } from "../telegram/client";
import {
  consumirPropuestaClasificacion,
  obtenerPropuestaClasificacion,
  restaurarPropuestaClasificacion,
  type PropuestaClasificacion,
} from "./classificationStore";
import { archivarDocumentoEnDrive } from "./archiveFile";
import { guardarPendienteReglaClasificacion } from "./pendienteReglaClasificacionStore";
import { guardarPendienteAlertaDocumento } from "./pendienteAlertaDocumentoStore";
import { guardarPendienteReclasificacion } from "./pendienteReclasificacionStore";
import {
  consumirPendienteDesambiguacionPorId,
  obtenerPendienteDesambiguacionPorChat,
  restaurarPendienteDesambiguacion,
  type PendienteDesambiguacion,
} from "./disambiguationStore";
import { registrarDocumentoArchivadoDesdeCorreo } from "./documentoArchivadoPorCorreoStore";
import { transcribirParaCaptura } from "./transcribeForCapture";
import { iniciarSeleccionEmpresaCaptura } from "../knowledge/capturaEmpresaCallbackHandler";
import { avanzarColaCorreoSiActivo } from "../jobs/revisarCorreoNuevo";
import { extraerDatosFactura } from "./extractInvoiceData";
import { MIMES_LEGIBLES_COMO_FACTURA, procesarEmlComoGastoForzado } from "./procesarDocumentoLocal";
import { esArchivoEml } from "./parseEml";
import { procesarGastoEntrante } from "../gastos/procesarGastoEntrante";
import type { ResultadoGastoEntrante } from "../gastos/procesarGastoEntrante";
import { ofrecerResponderCorreo } from "../gmail/emailCallbackHandler";
import type { IdentidadCorreoCola } from "../gmail/colaRevisionStore";
import type { TelegramCallbackQuery } from "../telegram/types";

type ResultadoGastoRedirigido =
  | ResultadoGastoEntrante
  | "gasto_propuesto"
  | "gasto_pendiente_datos"
  | "gasto_duplicado";

/**
 * Redirigir un documento al flujo de gastos solo cierra el correo cuando ese mismo paso demuestra
 * que el gasto ya estaba resuelto. `propuesta_enviada`/`gasto_propuesto` y ambos estados
 * `pendiente_datos` son traspasos a otro estado interactivo: la creación, conciliación, descarte o
 * resolución posterior será el único punto que avance la cola.
 */
export function debeAvanzarColaTrasRedirigirGasto(resultado: ResultadoGastoRedirigido): boolean {
  return resultado === "propuesta_duplicada" || resultado === "gasto_duplicado";
}

function identidadCorreoEsperada(correoOrigen: { threadId: string; mensajeIdGmail?: string }): {
  threadId: string;
  mensajeId?: string;
} {
  return { threadId: correoOrigen.threadId, mensajeId: correoOrigen.mensajeIdGmail };
}

/**
 * Las respuestas laterales poseen una unidad adicional de la cola. Solo
 * pueden reservarla si el documento conserva la identidad compuesta exacta;
 * una fila legacy parcial mantiene disponible la decisión principal, pero no
 * publica una acción que luego pudiera cerrar otro mensaje del mismo hilo.
 * `null` distingue un documento ajeno a la cola de uno de cola incompleto.
 */
export function identidadColaDocumentoParaRespuesta(
  correoOrigen: { deColaCorreo?: boolean; threadId: string; mensajeIdGmail?: string }
): Required<IdentidadCorreoCola> | null | undefined {
  if (correoOrigen.deColaCorreo !== true) return null;
  const threadId = correoOrigen.threadId?.trim();
  const mensajeId = correoOrigen.mensajeIdGmail?.trim();
  return threadId && mensajeId ? { threadId, mensajeId } : undefined;
}

/**
 * Una acción documental terminal ya no depende de que Telegram acepte el
 * mensaje de presentación. El store que originó el callback se reclama
 * antes de llegar aquí; por eso esta función cierra exactamente esa
 * identidad de Gmail una vez y solo después intenta renderizar el resultado.
 */
export async function finalizarDocumentoTerminalAntesDeRender(
  chatId: number,
  correoOrigen: { threadId: string; mensajeIdGmail?: string; deColaCorreo?: boolean } | undefined,
  claveIdempotencia: string,
  renderizar: () => Promise<unknown>,
  avanzar: (
    chatId: number,
    identidad: { threadId?: string; mensajeId?: string },
    claveIdempotencia?: string
  ) => Promise<unknown> = avanzarColaCorreoSiActivo
): Promise<void> {
  if (correoOrigen?.deColaCorreo) {
    await avanzar(chatId, identidadCorreoEsperada(correoOrigen), claveIdempotencia);
  }
  try {
    await renderizar();
  } catch (error) {
    console.error("[documentCallbackHandler] La acción terminó, pero no se pudo reflejar en Telegram (no crítico):", error);
  }
}

/**
 * Transfiere una desambiguación ya reclamada al siguiente estado durable. Si
 * crear la captura falla, repone exactamente la pregunta original para que el
 * correo conserve una única acción resoluble.
 */
export async function transferirDesambiguacionACaptura(
  pendiente: PendienteDesambiguacion,
  crearCaptura: (pendiente: PendienteDesambiguacion) => Promise<void>,
  restaurar: (pendiente: PendienteDesambiguacion) => Promise<unknown> = restaurarPendienteDesambiguacion
): Promise<void> {
  try {
    await crearCaptura(pendiente);
  } catch (error) {
    await restaurar(pendiente);
    throw error;
  }
}

function botonesPropuestaDocumento(propuesta: PropuestaClasificacion) {
  const filas = [
    [
      { text: "✅ Sí, archivar aquí", callback_data: `doc_confirm:${propuesta.id}` },
      { text: "✏️ Elegir otra carpeta", callback_data: `doc_reroute:${propuesta.id}` },
    ],
    [{ text: "💰 Es un gasto — procesarlo en Holded", callback_data: `doc_esgasto:${propuesta.id}` }],
    [
      { text: "📚 Enseñar regla", callback_data: `doc_regla:${propuesta.id}` },
      { text: "⏰ Crear alerta", callback_data: `doc_alerta:${propuesta.id}` },
    ],
    [{ text: "🧠 Guardar como conocimiento", callback_data: `doc_conocimiento:${propuesta.id}` }],
    [{ text: "❌ Descartar, no archivar", callback_data: `doc_descartar:${propuesta.id}` }],
  ];
  if (propuesta.correoOrigen) {
    filas.push([{ text: "✍️ Generar respuesta al correo", callback_data: `doc_responder:${propuesta.id}` }]);
  }
  return filas;
}

async function restaurarBotonesDocumento(propuesta: PropuestaClasificacion, aviso: string): Promise<void> {
  const restaurada = await restaurarPropuestaClasificacion(propuesta);
  await editTelegramMessage(
    restaurada.chatId,
    restaurada.messageId,
    aviso,
    botonesPropuestaDocumento(restaurada)
  );
}

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

    const identidadRespuesta = identidadColaDocumentoParaRespuesta(propuestaPeek.correoOrigen);
    if (propuestaPeek.correoOrigen.deColaCorreo === true && !identidadRespuesta) {
      await sendTelegramMessage(
        propuestaPeek.chatId,
        "⚠️ No publiqué la respuesta porque este documento no conserva la identidad completa del correo. La propuesta principal sigue pendiente."
      );
      return;
    }

    const publicada = await ofrecerResponderCorreo(
      propuestaPeek.chatId,
      propuestaPeek.correoOrigen.de,
      propuestaPeek.correoOrigen.asunto,
      propuestaPeek.correoOrigen.threadId,
      propuestaPeek.correoOrigen.messageIdHeader,
      contexto,
      identidadRespuesta
    );
    if (!publicada) {
      await sendTelegramMessage(
        propuestaPeek.chatId,
        "⚠️ No pude publicar de forma segura la pregunta de respuesta. La propuesta principal sigue pendiente."
      ).catch(() => undefined);
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
    const propuestaTrabajo = deColaCorreo
      ? await consumirPropuestaClasificacion(id)
      : propuestaPeek;
    if (!propuestaTrabajo) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya está siendo procesada o ya fue resuelta.");
      return;
    }

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
        propuestaTrabajo.chatId,
        propuestaTrabajo.messageId,
        `🧠 Leyendo "${propuestaTrabajo.nombreArchivoOriginal}" para guardarlo como conocimiento...`,
        []
      ).catch((error) => console.error("[documentCallbackHandler] No se pudo limpiar los botones del mensaje original (no crítico):", error));
    }

    try {
      const transcripcion = await transcribirParaCaptura(propuestaTrabajo.rutaLocal, propuestaTrabajo.mimeType, undefined);
      const contenido = [
        `Documento: ${propuestaTrabajo.nombreArchivoOriginal} (${propuestaTrabajo.clasificacion.empresa} — ${propuestaTrabajo.clasificacion.tipoDocumento})`,
        "",
        transcripcion,
      ].join("\n");
      await iniciarSeleccionEmpresaCaptura(propuestaTrabajo.chatId, contenido, propuestaTrabajo.nombreArchivoOriginal,
        undefined, deColaCorreo, propuestaTrabajo.correoOrigen
          ? { threadId: propuestaTrabajo.correoOrigen.threadId, mensajeId: propuestaTrabajo.correoOrigen.mensajeIdGmail }
          : undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[documentCallbackHandler] Error leyendo documento para guardar como conocimiento:", message);
      await sendTelegramMessage(
        propuestaTrabajo.chatId,
        `⚠️ No se pudo leer "${propuestaTrabajo.nombreArchivoOriginal}" para guardarlo como conocimiento: ${message}`
      ).catch(() => undefined);
      if (deColaCorreo) {
        await restaurarBotonesDocumento(
          propuestaTrabajo,
          `⚠️ No se pudo leer "${propuestaTrabajo.nombreArchivoOriginal}" para guardarlo como conocimiento: ${message}\n\n` +
            `El correo sigue sin leer y puedes reintentar o elegir otra acción sin reenviar el documento.`
        );
      }
    }

    // En la cola la propuesta ya fue reclamada/consumida antes de la
    // transcripción; fuera de la cola se conserva para poder archivar además.
    return;
  }

  // "💰 Es un gasto — procesarlo en Holded" — hallazgo real de auditoría (Footprint, factura Hotel
  // Columbus/Costa Rica, 2026-09-16): el clasificador de documentos (solo texto) reconoció por
  // contexto que esto es un gasto de viaje real, pero solo podía ofrecer archivarlo — no había forma
  // de redirigirlo al flujo real de gasto. Relee el documento con extraerDatosFactura (la misma
  // lectura con visión que procesarDocumentoLocal.ts usa siempre) pero, a diferencia del camino
  // automático, el usuario YA confirmó que es un gasto — se fuerza esFacturaOGasto=true y se usan los
  // demás datos que sí haya logrado leer (proveedor/monto/fecha/líneas), aunque el modelo haya dudado
  // del tipo de documento. Fuera de la cola conserva la propuesta documental para que también pueda
  // archivarse; dentro de la cola la transfiere al pendiente/propuesta de gasto y cierra estos botones,
  // sin cerrar el correo hasta que el flujo de gasto tenga una resolución terminal real.
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
    const propuestaTrabajo = deColaCorreo
      ? await consumirPropuestaClasificacion(id)
      : propuestaPeek;
    if (!propuestaTrabajo) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya está siendo procesada o ya fue resuelta.");
      return;
    }
    await answerCallbackQuerySafe(callback.id, "Leyendo el comprobante...");

    // Mismo motivo que en "🧠 Guardar como conocimiento": si viene de la cola, se le quitan los
    // botones al mensaje original YA MISMO (antes de la relectura, que tarda varios segundos) para
    // reducir la ventana de un doble-tap que resuelva el mismo adjunto dos veces.
    if (deColaCorreo) {
      await editTelegramMessage(
        propuestaTrabajo.chatId,
        propuestaTrabajo.messageId,
        `💰 Procesando "${propuestaTrabajo.nombreArchivoOriginal}" como gasto...`,
        []
      ).catch((error) => console.error("[documentCallbackHandler] No se pudo limpiar los botones del mensaje original (no crítico):", error));
    }

    const captionReconstruido = propuestaTrabajo.correoOrigen
      ? `Adjunto de correo. De: ${propuestaTrabajo.correoOrigen.de}. Asunto: ${propuestaTrabajo.correoOrigen.asunto}.`
      : undefined;

    let resultadoGasto: ResultadoGastoRedirigido | undefined;
    try {
      if (esEml) {
        const resultadoEml = await procesarEmlComoGastoForzado({
          chatId: propuestaTrabajo.chatId,
          rutaLocal: propuestaTrabajo.rutaLocal,
          nombreArchivoOriginal: propuestaTrabajo.nombreArchivoOriginal,
          mimeType: propuestaTrabajo.mimeType,
          nombreParaClasificar: propuestaTrabajo.nombreArchivoOriginal,
          captionEfectivo: captionReconstruido,
          correoOrigen: propuestaTrabajo.correoOrigen,
        });
        if (resultadoEml.error) {
          throw new Error(resultadoEml.error);
        }
        resultadoGasto = resultadoEml.resultado;
      } else {
        const datosFactura = await extraerDatosFactura(
          propuestaTrabajo.rutaLocal,
          propuestaTrabajo.mimeType,
          captionReconstruido,
          propuestaTrabajo.nombreArchivoOriginal
        );
        const resultado = await procesarGastoEntrante({
          chatId: propuestaTrabajo.chatId,
          rutaLocal: propuestaTrabajo.rutaLocal,
          nombreArchivoOriginal: propuestaTrabajo.nombreArchivoOriginal,
          mimeType: propuestaTrabajo.mimeType,
          // El usuario ya confirmó con este botón que SÍ es un gasto — se fuerza el campo aunque la
          // relectura vuelva a dudarlo, pero se conservan los demás datos que sí logró leer.
          datos: { ...datosFactura, esFacturaOGasto: true },
          deColaCorreo,
          origenAdjuntoGmail:
            propuestaTrabajo.correoOrigen?.mensajeIdGmail && propuestaTrabajo.correoOrigen?.attachmentIdGmail
              ? {
                  mensajeIdGmail: propuestaTrabajo.correoOrigen.mensajeIdGmail,
                  attachmentIdGmail: propuestaTrabajo.correoOrigen.attachmentIdGmail,
                  partId: propuestaTrabajo.correoOrigen.partId,
                }
              : undefined,
          correoOrigen: propuestaTrabajo.correoOrigen
            ? {
                de: propuestaTrabajo.correoOrigen.de,
                asunto: propuestaTrabajo.correoOrigen.asunto,
                threadId: propuestaTrabajo.correoOrigen.threadId,
                messageIdHeader: propuestaTrabajo.correoOrigen.messageIdHeader,
                mensajeIdGmail: propuestaTrabajo.correoOrigen.mensajeIdGmail,
              }
            : undefined,
        });
        resultadoGasto = resultado;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[documentCallbackHandler] Error procesando documento como gasto:", message);
      await sendTelegramMessage(
        propuestaTrabajo.chatId,
        `⚠️ No se pudo procesar "${propuestaTrabajo.nombreArchivoOriginal}" como gasto: ${message}`
      ).catch(() => undefined);
      if (deColaCorreo) {
        await restaurarBotonesDocumento(
          propuestaTrabajo,
          `⚠️ No se pudo procesar "${propuestaTrabajo.nombreArchivoOriginal}" como gasto: ${message}\n\n` +
            `El correo sigue sin leer y puedes reintentar o elegir otra acción sin reenviar el documento.`
        );
      }
    }

    // Si el flujo de gasto recibió el documento, pasa a ser el único dueño de la resolución aunque
    // todavía esté esperando datos o aprobación. Cerramos la propuesta documental para que sus
    // botones no puedan crear un segundo flujo, pero NO avanzamos el correo por una mera propuesta:
    // gastoCallbackHandler/reintentarGastoPendiente lo harán una sola vez cuando exista un resultado
    // terminal real. Un duplicado ya verificado sí es terminal en este mismo paso.
    if (resultadoGasto && deColaCorreo) {
      if (debeAvanzarColaTrasRedirigirGasto(resultadoGasto) && propuestaTrabajo.correoOrigen) {
        await avanzarColaCorreoSiActivo(
          propuestaTrabajo.chatId,
          identidadCorreoEsperada(propuestaTrabajo.correoOrigen),
          `documento:${propuestaTrabajo.id}:resolver`
        );
      }
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
    const propuestaDescartar = await consumirPropuestaClasificacion(id);
    if (!propuestaDescartar) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya está siendo procesada o ya fue resuelta.");
      return;
    }
    await registrarResolucionDesdeCorreo(propuestaDescartar.correoOrigen);
    await unlink(propuestaDescartar.rutaLocal).catch(() => {});
    await finalizarDocumentoTerminalAntesDeRender(
      propuestaDescartar.chatId,
      propuestaDescartar.correoOrigen,
      `documento:${propuestaDescartar.id}:resolver`,
      () => editTelegramMessage(
        propuestaDescartar.chatId,
        propuestaDescartar.messageId,
        `❌ Descartado — "${propuestaDescartar.nombreArchivoOriginal}" (no se archivó ni se guardó nada).`,
        []
      )
    );
    return;
  }

  if (accion === "doc_reroute") {
    await answerCallbackQuerySafe(callback.id);
    const propuestaReroute = await consumirPropuestaClasificacion(id);
    if (!propuestaReroute) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya está siendo procesada o ya fue resuelta.");
      return;
    }

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
      id: propuestaReroute.id,
      chatId: propuestaReroute.chatId,
      rutaLocal: propuestaReroute.rutaLocal,
      nombreArchivoOriginal: propuestaReroute.nombreArchivoOriginal,
      mimeType: propuestaReroute.mimeType,
      tipoDocumentoOriginal: propuestaReroute.clasificacion.tipoDocumento,
      correoOrigen: propuestaReroute.correoOrigen,
    })
      .then(() => true)
      .catch((error) => {
        console.error("[documentCallbackHandler] Error guardando el pendiente de reclasificación:", error);
        return false;
      });

    if (!guardado) {
      await restaurarBotonesDocumento(
        propuestaReroute,
        `⚠️ No pude preparar "${propuestaReroute.nombreArchivoOriginal}" para elegir otra carpeta. ` +
          `El correo sigue sin leer y la propuesta quedó restaurada; vuelve a intentarlo.`
      );
      return;
    }

    // Hallazgo real de auditoría: este mensaje pedía la empresa/carpeta a ciegas, sin decir que se
    // puede pedir ver las carpetas que ya existen, crear una nueva, o simplemente descartarlo —
    // Carlos no tiene por qué saber de memoria la estructura real de Drive. Las tres ya son posibles
    // (listar_carpetas_drive, crearCarpetaSiNoExiste y descartar_documento_pendiente), solo hacía
    // falta decirlo.
    await editTelegramMessage(
      propuestaReroute.chatId,
      propuestaReroute.messageId,
      `✏️ Ok — dime la empresa y carpeta correctas para "${propuestaReroute.nombreArchivoOriginal}" (ej. "EWORKS, en Colaboradores/Alejandra"). ` +
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
  const propuestaConfirmar = await consumirPropuestaClasificacion(id);
  if (!propuestaConfirmar) {
    await answerCallbackQuerySafe(callback.id, "Esta propuesta ya está siendo procesada o ya fue resuelta.");
    return;
  }

  const resultado = await archivarDocumentoEnDrive(propuestaConfirmar);

  if (resultado.ok) {
    await registrarResolucionDesdeCorreo(propuestaConfirmar.correoOrigen);
    // Solo avanza la cola si de verdad se archivó — si falló, mejor dejarlo
    // "activo" (visible, pendiente) que marcarlo leído sobre un documento
    // que en realidad nunca quedó guardado en ningún lado.
    await finalizarDocumentoTerminalAntesDeRender(
      propuestaConfirmar.chatId,
      propuestaConfirmar.correoOrigen,
      `documento:${propuestaConfirmar.id}:resolver`,
      () => editTelegramMessage(
        propuestaConfirmar.chatId,
        propuestaConfirmar.messageId,
        `✅ Archivado — ${propuestaConfirmar.nombreArchivoOriginal}\n${resultado.mensaje}\n\n🔗 ${resultado.webViewLink}`,
        []
      )
    );
  } else {
    await restaurarPropuestaClasificacion(propuestaConfirmar);
    await editTelegramMessage(
      propuestaConfirmar.chatId,
      propuestaConfirmar.messageId,
      `⚠️ No se pudo confirmar el archivado — ${propuestaConfirmar.nombreArchivoOriginal}\n\n${resultado.mensaje}\n\nLa propuesta sigue disponible. Puedes reintentar; si Drive ya lo recibió, WOBI solo lo verificará y no volverá a subirlo.`,
      [
        [{ text: "🔄 Verificar / reintentar", callback_data: `doc_retry:${propuestaConfirmar.id}:${Date.now().toString(36)}` }],
        [
          { text: "✏️ Elegir otra carpeta", callback_data: `doc_reroute:${propuestaConfirmar.id}:${Date.now().toString(36)}` },
          { text: "❌ Descartar", callback_data: `doc_descartar:${propuestaConfirmar.id}:${Date.now().toString(36)}` },
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

  if (accion === "desamb_carpeta") {
    await answerCallbackQuerySafe(callback.id);
    await solicitarRespuestaCarpeta(chatId, idBoton);
    return;
  }


  // "📁 <carpeta>" — botón directo por cada carpeta candidata que el clasificador ya identificó como
  // real (ver ClasificacionDocumento.carpetasCandidatas / processClassification.ts). A diferencia de
  // los 3 de arriba, este SÍ consume la pregunta — archiva de una vez, igual que "✅ Sí, archivar
  // aquí" en el flujo de confianza alta/media, sin volver a pasar por el clasificador de texto.
  if (accion === "desamb_elegir") {
    // Validar la opción contra una lectura sin consumir. Antes se borraba la
    // pregunta primero; un índice inválido dejaba el correo UNREAD pero sin
    // ninguna acción disponible para resolverlo.
    const todas = idBoton ? await obtenerPendienteDesambiguacionPorChat(chatId).catch(() => []) : [];
    const pendientePeek = todas.find((item) => item.id === idBoton);
    if (!pendientePeek) {
      await answerCallbackQuerySafe(callback.id, "Esta pregunta ya no está disponible (expiró o ya se respondió).");
      return;
    }
    const indice = Number(indiceCarpetaRaw);
    const carpeta = Number.isInteger(indice) && indice >= 0 && pendientePeek.empresa && pendientePeek.carpetasCandidatas
      ? pendientePeek.carpetasCandidatas[indice]
      : undefined;
    if (!pendientePeek.empresa || !carpeta) {
      await answerCallbackQuerySafe(callback.id, "Esa opción ya no es válida.");
      return;
    }

    const pendiente = await consumirPendienteDesambiguacionPorId(pendientePeek.id, chatId);
    if (!pendiente) {
      await answerCallbackQuerySafe(callback.id, "Esta pregunta ya está siendo procesada o ya fue resuelta.");
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

    try {
      const resultado = await archivarDocumentoEnDrive(propuestaSintetica);

      if (resultado.ok) {
        await registrarResolucionDesdeCorreo(pendiente.correoOrigen);
        await finalizarDocumentoTerminalAntesDeRender(
          chatId,
          pendiente.correoOrigen,
          `documento-desambiguacion:${pendiente.id}:resolver`,
          () => sendTelegramMessage(chatId, `✅ Archivado — ${pendiente.nombreArchivoOriginal}\n${resultado.mensaje}\n\n🔗 ${resultado.webViewLink}`)
        );
        return;
      }

      // Drive no confirmó el archivado: la misma pregunta y sus botones
      // vuelven al store. El operador puede reintentar sin reenviar nada.
      await restaurarPendienteDesambiguacion(pendiente);
      await sendTelegramMessage(
        chatId,
        `⚠️ No se pudo archivar "${pendiente.nombreArchivoOriginal}" en "${carpeta}": ${resultado.mensaje} ` +
          `La pregunta sigue disponible y el correo permanece sin leer; puedes volver a usar sus botones.`
      );
    } catch (error) {
      await restaurarPendienteDesambiguacion(pendiente).catch((errorRestauracion) =>
        console.error("[documentCallbackHandler] No se pudo restaurar la desambiguación tras el fallo de Drive:", errorRestauracion)
      );
      const detalle = error instanceof Error ? error.message : String(error);
      console.error("[documentCallbackHandler] Error resolviendo la carpeta ambigua:", error);
      await sendTelegramMessage(
        chatId,
        `⚠️ No pude terminar el archivado de "${pendiente.nombreArchivoOriginal}" (${detalle}). ` +
          `El correo sigue sin leer y la pregunta fue restaurada para reintentar.`
      ).catch(() => {});
    }
    return;
  }

  // "💰 Es un gasto — procesarlo en Holded" — pedido explícito de Carlos (mismo caso Footprint,
  // hotel APECS Noruega, 2026-09-18): "a todos los botones que me des, siempre... inclúyele un botón
  // que dice procesar como gasto. De esa manera nos aseguramos que si lo procesas mal, lo podemos
  // reencaminar inmediatamente" — este botón faltaba por completo en la pregunta de desambiguación
  // (solo existía en el flujo de confianza alta/media, doc_esgasto), así que un documento realmente
  // ambiguo tenía MENOS forma de corregirse hacia gasto que uno bien clasificado. Mismo mecanismo que
  // doc_esgasto: relee con extraerDatosFactura, fuerza esFacturaOGasto=true. Consume primero esta
  // pregunta para que sus otros botones no abran un segundo flujo concurrente; si se crea una
  // propuesta o un pendiente de datos, la cola permanece activa hasta su resolución terminal.
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

    let resultadoGasto: ResultadoGastoRedirigido | undefined;
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
        resultadoGasto = resultadoEml.resultado;
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
        resultadoGasto = resultado;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[documentCallbackHandler] Error procesando documento ambiguo como gasto:", message);
      await restaurarPendienteDesambiguacion(pendiente).catch((errorRestauracion) => {
        console.error("[documentCallbackHandler] No se pudo restaurar la pregunta ambigua:", errorRestauracion);
      });
      await sendTelegramMessage(
        chatId,
        `⚠️ No se pudo procesar "${pendiente.nombreArchivoOriginal}" como gasto: ${message}. ` +
          `El correo sigue sin leer y los botones de la pregunta original vuelven a estar disponibles; no reenvíes el documento.`
      );
    }

    // El registro documental ya se consumió arriba para impedir un segundo callback. La propuesta o
    // la petición de datos del flujo de gastos siguen siendo intermedias y mantienen este correo
    // activo; solo un duplicado ya comprobado permite cerrarlo en este paso.
    if (
      resultadoGasto &&
      deColaCorreo &&
      debeAvanzarColaTrasRedirigirGasto(resultadoGasto) &&
      pendiente.correoOrigen
    ) {
      await avanzarColaCorreoSiActivo(
        chatId,
        identidadCorreoEsperada(pendiente.correoOrigen),
        `documento-desambiguacion:${pendiente.id}:resolver`
      );
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
      const identidadRespuesta = identidadColaDocumentoParaRespuesta(pendientePeek.correoOrigen);
      if (pendientePeek.correoOrigen.deColaCorreo === true && !identidadRespuesta) {
        await sendTelegramMessage(
          chatId,
          "⚠️ No publiqué la respuesta porque este documento no conserva la identidad completa del correo. La pregunta principal sigue pendiente."
        );
        return;
      }
      const publicada = await ofrecerResponderCorreo(
        chatId,
        pendientePeek.correoOrigen.de,
        pendientePeek.correoOrigen.asunto,
        pendientePeek.correoOrigen.threadId,
        pendientePeek.correoOrigen.messageIdHeader,
        `Se recibió "${pendientePeek.nombreArchivoOriginal}", todavía sin identificar con certeza a qué empresa/carpeta pertenece. Redacta una respuesta breve y profesional (ej. acuse de recibo).`,
        identidadRespuesta
      );
      if (!publicada) {
        await sendTelegramMessage(
          chatId,
          "⚠️ No pude publicar de forma segura la pregunta de respuesta. La pregunta principal sigue pendiente."
        ).catch(() => undefined);
      }
      return;
    }

    // desamb_conocimiento: reclama la pregunta original ANTES de crear el
    // nuevo pendiente. Así la decisión se transfiere, no se duplica; si el
    // nuevo estado no llega a persistirse, la pregunta original se restaura.
    const pendiente = idBoton ? await consumirPendienteDesambiguacionPorId(idBoton, chatId) : undefined;
    if (!pendiente) {
      await sendTelegramMessage(chatId, "Esta pregunta ya no está disponible (expiró o ya se respondió).").catch(() => {});
      return;
    }
    try {
      await transferirDesambiguacionACaptura(pendiente, async (reclamada) => {
        const transcripcion = await transcribirParaCaptura(reclamada.rutaLocal, reclamada.mimeType, reclamada.captionOriginal);
        const contenido = [
          reclamada.correoOrigen
            ? `De: ${reclamada.correoOrigen.de}\nAsunto: ${reclamada.correoOrigen.asunto}`
            : `Archivo: ${reclamada.nombreArchivoOriginal}`,
          "",
          transcripcion,
        ].join("\n");
        await iniciarSeleccionEmpresaCaptura(chatId, contenido, reclamada.nombreArchivoOriginal, undefined,
          reclamada.correoOrigen?.deColaCorreo === true, reclamada.correoOrigen
            ? { threadId: reclamada.correoOrigen.threadId, mensajeId: reclamada.correoOrigen.mensajeIdGmail }
            : undefined);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[documentCallbackHandler] Error leyendo documento ambiguo para guardar como conocimiento:", message);
      await sendTelegramMessage(
        chatId,
        `⚠️ No se pudo leer "${pendiente.nombreArchivoOriginal}" para guardarlo como conocimiento: ${message}. ` +
          "La pregunta original sigue disponible; no reenvíes el documento."
      ).catch(() => {});
    }
    return;
  }

  if (accion !== "desamb_descartar") {
    await answerCallbackQuerySafe(callback.id, "Acción de documento no reconocida.");
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
  await finalizarDocumentoTerminalAntesDeRender(
    chatId,
    pendiente.correoOrigen,
    `documento-desambiguacion:${pendiente.id}:resolver`,
    () => sendTelegramMessage(chatId, `❌ Descartado — "${pendiente.nombreArchivoOriginal}" (no se archivó ni se guardó nada).`)
  );
}

import { editTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";
import { clasificarDocumento, type ClasificacionDocumento } from "./classifyFile";
import {
  crearPropuestaClasificacion,
  actualizarMessageIdClasificacion,
  consumirPropuestaClasificacion,
  obtenerPropuestaClasificacion,
} from "./classificationStore";
import {
  actualizarMessageIdDesambiguacion,
  consumirPendienteDesambiguacionPorId,
  guardarPendienteDesambiguacion,
  obtenerPendienteDesambiguacionPorChat,
} from "./disambiguationStore";
import { transcribirParaCaptura } from "./transcribeForCapture";
import { iniciarSeleccionEmpresaCaptura } from "../knowledge/capturaEmpresaCallbackHandler";
import { ofrecerResponderCorreo } from "../gmail/emailCallbackHandler";
import {
  incrementarPendientesActivo,
  revertirIncrementoPendientesActivo,
  type IdentidadCorreoCola,
} from "../gmail/colaRevisionStore";

export interface ArchivoParaClasificar {
  chatId: number;
  rutaLocal: string;
  nombreArchivoOriginal: string;
  mimeType?: string;
  nombreParaClasificar: string;
  /** Caption original del usuario, o el texto ya enriquecido con su aclaración. */
  captionEfectivo?: string;
  /** Si vino de un correo, sus datos — para poder responderlo después de archivar (ver DocumentoLocalEntrante). */
  correoOrigen?: { de: string; asunto: string; threadId: string; messageIdHeader: string; deColaCorreo?: boolean; /** Gmail interno (correo.id) + attachmentId del adjunto real — permite volver a descargarlo de Gmail si la copia local en tmp/uploads se pierde (ej. un redeploy de Railway entre que se descarga y que se usa). */ mensajeIdGmail?: string; attachmentIdGmail?: string; /** Identidad ESTABLE del adjunto entre lecturas del correo (a diferencia de attachmentIdGmail) — ver AdjuntoCorreo.partId en gmail/client.ts. Se usa para "¿ya procesé este adjunto?", nunca para descargar. */ partId?: string };
  /**
   * true cuando esta llamada es la continuación tras responder una pregunta
   * de desambiguación (ver server.ts) — evita ofrecer captura/respuesta una
   * SEGUNDA vez (ya se ofreció en la llamada original, antes de preguntar
   * la carpeta).
   */
  esContinuacionDesambiguacion?: boolean;
  /**
   * Pedido explícito de Carlos, tras un caso real: un correo con 2 adjuntos
   * distintos (una Loading Instruction y un EAD, ambos del mismo expediente
   * de envío marítimo) mandó 2 propuestas seguidas y pareció "llegó
   * duplicado" — no era un duplicado, eran 2 documentos reales distintos,
   * pero nada en el mensaje lo aclaraba. Cuando el correo trae más de un
   * adjunto, esto trae una nota tipo "Adjunto 2 de 2 de este correo" para
   * que quede claro que son decisiones independientes, no un error.
   */
  notaAdjunto?: string;
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

  const origenEsCola = archivo.correoOrigen?.deColaCorreo === true;
  const identidadCola: Required<IdentidadCorreoCola> | undefined =
    origenEsCola && archivo.correoOrigen?.threadId?.trim() && archivo.correoOrigen.mensajeIdGmail?.trim()
      ? {
          threadId: archivo.correoOrigen.threadId.trim(),
          mensajeId: archivo.correoOrigen.mensajeIdGmail.trim(),
        }
      : undefined;

  if (origenEsCola && !identidadCola) {
    // La propuesta principal del documento sigue disponible. Las propuestas
    // laterales se omiten si no pueden poseer una unidad ligada al correo
    // exacto; nunca se las deja capaces de cerrar otro correo por chatId.
    console.error("[processClassification] No se ofrecieron captura/respuesta: falta identidad exacta del correo de cola.");
    return;
  }

  if (identidadCola) {
    let capturaReservada = false;
    try {
      capturaReservada = await incrementarPendientesActivo(archivo.chatId, identidadCola);
      if (!capturaReservada) {
        console.error("[processClassification] El correo ya no era el activo; no se publicó la captura lateral.");
      } else {
        // iniciarSeleccionEmpresaCaptura solo resuelve después de publicar Y
        // persistir. Si falla cualquiera de las dos partes se compensa abajo.
        await iniciarSeleccionEmpresaCaptura(
          archivo.chatId,
          contenidoCaptura,
          archivo.correoOrigen?.de ?? archivo.nombreArchivoOriginal,
          undefined,
          true,
          identidadCola
        );
      }
    } catch (error) {
      if (capturaReservada) {
        await revertirIncrementoPendientesActivo(archivo.chatId, identidadCola).catch((errorCompensando) =>
          console.error("[processClassification] No se pudo compensar la reserva de captura fallida:", errorCompensando)
        );
      }
      console.error("[processClassification] No se pudo publicar/persistir la captura lateral:", error);
    }
  } else {
    await iniciarSeleccionEmpresaCaptura(
      archivo.chatId,
      contenidoCaptura,
      archivo.correoOrigen?.de ?? archivo.nombreArchivoOriginal,
      undefined,
      false
    );
  }

  if (archivo.correoOrigen) {
    const contextoRespuesta =
      `Se recibió "${archivo.nombreArchivoOriginal}" (${clasificacion.tipoDocumento}) y se propuso guardar ` +
      `como conocimiento consultable (además de archivarlo en Drive si se aprueba). Contenido transcrito: ` +
      `${transcripcion}. Escribe una respuesta breve y cálida confirmando que quedó registrado/anotado.`;

    const respuestaPublicada = await ofrecerResponderCorreo(
      archivo.chatId,
      archivo.correoOrigen.de,
      archivo.correoOrigen.asunto,
      archivo.correoOrigen.threadId,
      archivo.correoOrigen.messageIdHeader,
      contextoRespuesta,
      identidadCola ?? null
    );
    if (!respuestaPublicada) {
      console.error("[processClassification] No se pudo publicar/persistir la oferta lateral de respuesta.");
    }
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

  // Bug real encontrado en vivo (2026-09-03): si esto YA es la continuación
  // de una desambiguación (el usuario acaba de responder la pregunta de
  // "¿a qué empresa/carpeta pertenece?") y el clasificador SIGUE sin llegar
  // a confianza alta/media — porque el documento de verdad no encaja limpio
  // en ninguna carpeta real, o porque en realidad no es un archivo para
  // archivar sino contenido para guardar como conocimiento (caso real:
  // Carlos respondiendo "esta información debe hacer parte de WOBA, no es
  // un documento, es conocimiento") — antes esto volvía a guardar OTRA
  // pregunta de desambiguación en texto libre y a mandarla de nuevo, sin
  // límite de reintentos. Como server.ts intercepta CUALQUIER mensaje de
  // texto siguiente como respuesta a esa pregunta (ver
  // consumirPendienteDesambiguacion), un documento que nunca logra
  // clasificarse con confianza podía atrapar la conversación indefinidamente
  // — incluso preguntas del usuario totalmente distintas se interpretaban
  // como un nuevo intento de responder "empresa y carpeta". Ahora, en la
  // continuación, nunca se repite el ciclo de texto libre: se pasa directo
  // a la propuesta con botones de abajo (que YA incluye "🧠 Guardar como
  // conocimiento" y "✏️ Elegir otra carpeta" como alternativas reales),
  // cortando el ciclo en el primer reintento fallido en vez de dejarlo
  // abierto para siempre.
  if (clasificacion.confianza === "baja" && !archivo.esContinuacionDesambiguacion) {
    const pregunta = clasificacion.preguntaSiAmbiguo ?? "¿A qué empresa y carpeta pertenece este documento?";

    // Hallazgo real de auditoría: si YA hay otra(s) pregunta(s) de desambiguación sin responder para
    // este chat (ver disambiguationStore.ts — ahora pueden coexistir varias), una respuesta de texto
    // libre siempre resuelve la más antigua primero — sin avisarlo, no queda claro a cuál de las
    // preguntas visibles en el chat le está respondiendo el usuario. Pedido explícito de Carlos: los
    // avisos deben ser comprensibles y no dejar duda de qué hacer.
    const otrasPendientes = await obtenerPendienteDesambiguacionPorChat(archivo.chatId).catch(() => []);

    const pendiente = await guardarPendienteDesambiguacion({
      chatId: archivo.chatId,
      messageId: 0,
      rutaLocal: archivo.rutaLocal,
      nombreArchivoOriginal: archivo.nombreArchivoOriginal,
      mimeType: archivo.mimeType,
      nombreParaClasificar: archivo.nombreParaClasificar,
      captionOriginal: archivo.captionEfectivo,
      preguntaFormulada: pregunta,
      correoOrigen: archivo.correoOrigen,
      empresa: clasificacion.empresa !== "desconocida" ? clasificacion.empresa : undefined,
      carpetasCandidatas: clasificacion.carpetasCandidatas,
    });

    const notaVariasPendientes =
      otrasPendientes.length > 0
        ? `\n\n(Ojo: si respondes por texto en vez de tocar un botón, tu respuesta se aplica a la pregunta MÁS ANTIGUA sin responder de las ${otrasPendientes.length + 1} que tienes pendientes — para descartar esta en particular, usa el botón de abajo.)`
        : "";
    const textoPregunta = (archivo.notaAdjunto ? `${archivo.notaAdjunto}\n\n${pregunta}` : pregunta) + notaVariasPendientes;

    // Pedido explícito de Carlos: siempre debe haber forma de decir "no
    // hagas nada con esto" en vez de verse forzado a responder o quedar
    // atrapado. Antes esta pregunta se mandaba sin ningún botón. El id va en
    // el callback_data (bug real de auditoría: sin id, un botón viejo de una
    // pregunta ya reemplazada por un documento más reciente del mismo chat
    // podía descartar el documento ACTUAL sin relación con ese botón).
    //
    // Segundo hallazgo real de auditoría (Footprint, Modelo 303/349, 2026-09-17): "Descartar" era la
    // ÚNICA opción con botón — el resto ("guardar como conocimiento", "crear alerta", "generar
    // respuesta") solo existían del lado del flujo de confianza alta/media, así que un documento
    // ambiguo quedaba con menos alternativas reales que uno bien clasificado, justo al revés de lo
    // que hace falta. Ninguno de estos 3 consume la pregunta (igual que su equivalente en el flujo de
    // confianza alta/media) — responder por texto la empresa/carpeta, o "❌ Descartar", siguen
    // disponibles después.
    const filasBotonesDesambiguacion = [
      [
        { text: "🧠 Guardar como conocimiento", callback_data: `desamb_conocimiento:${pendiente.id}` },
        { text: "⏰ Crear alerta", callback_data: `desamb_alerta:${pendiente.id}` },
      ],
      // Pedido explícito de Carlos (Footprint, hotel APECS Noruega, 2026-09-18): red de seguridad
      // SIEMPRE presente, incluso (sobre todo) cuando el documento es tan ambiguo que ni siquiera se
      // pudo proponer una carpeta — "así creas que sea para procesar de manera diferente, inclúyele
      // un botón que dice procesar como gasto... si lo procesas mal, lo podemos reencaminar
      // inmediatamente". No depende de esProbableGasto ni de nada que el clasificador haya adivinado.
      [{ text: "💰 Es un gasto — procesarlo en Holded", callback_data: `desamb_esgasto:${pendiente.id}` }],
      [{ text: "❌ Descartar, no hacer nada", callback_data: `desamb_descartar:${pendiente.id}` }],
    ];
    if (archivo.correoOrigen) {
      filasBotonesDesambiguacion.splice(2, 0, [
        { text: "✍️ Generar respuesta al correo", callback_data: `desamb_responder:${pendiente.id}` },
      ]);
    }

    // Tercer hallazgo real de auditoría, mismo caso: la pregunta ya mencionaba las carpetas reales
    // candidatas POR NOMBRE en el texto, pero ningún botón permitía elegirlas — había que escribirlas
    // a mano. Solo si el clasificador SÍ trae empresa identificada y carpetas candidatas reales
    // (ver ClasificacionDocumento.carpetasCandidatas): un botón por candidata (máx 3, por índice — el
    // nombre completo puede exceder el límite de callback_data de Telegram) que archiva DIRECTO ahí,
    // igual que "✅ Sí, archivar aquí" en el flujo de confianza alta/media.
    if (pendiente.empresa && pendiente.carpetasCandidatas && pendiente.carpetasCandidatas.length > 0) {
      filasBotonesDesambiguacion.unshift(
        pendiente.carpetasCandidatas.map((carpeta, indice) => ({
          text: `📁 ${carpeta}`,
          callback_data: `desamb_elegir:${pendiente.id}:${indice}`,
        }))
      );
    }

    let messageIdPregunta = 0;
    try {
      messageIdPregunta = await sendTelegramMessageWithButtons(
        archivo.chatId,
        textoPregunta,
        filasBotonesDesambiguacion
      );
      const entregada = await actualizarMessageIdDesambiguacion(
        pendiente.id,
        archivo.chatId,
        messageIdPregunta
      );
      if (!entregada) throw new Error("La pregunta se publico, pero no se pudo confirmar su entrega durable.");
    } catch (error) {
      // La fila provisional nunca puede quedar haciendose pasar por una
      // pregunta visible. El wrapper del correo publicara un reintento
      // durable; si Telegram si alcanzo a mostrarla, se desactivan sus botones.
      await consumirPendienteDesambiguacionPorId(pendiente.id, archivo.chatId).catch(() => undefined);
      if (messageIdPregunta > 0) {
        await editTelegramMessage(
          archivo.chatId,
          messageIdPregunta,
          `⚠️ No pude confirmar esta pregunta de forma durable. El correo sigue sin leer y se reintentara sin usar estos botones.`,
          []
        ).catch(() => undefined);
      }
      throw error;
    }
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

  const textoPropuestaBase =
    clasificacion.confianza === "baja"
      ? [
          `Ya te pregunté una vez y sigo sin poder ubicar con certeza dónde archivar "${archivo.nombreArchivoOriginal}" ` +
            `(${clasificacion.razon}).`,
          clasificacion.empresa !== "desconocida" && clasificacion.carpetaSugerida !== "(sin sugerencia)"
            ? // Bug real encontrado en auditoría: sin mostrar la mejor suposición
              // acá, "✅ Sí, archivar aquí" quedaba como un botón "a ciegas" —
              // el texto anterior nunca decía a dónde apuntaba ese botón.
              `Mi mejor suposición es **${clasificacion.empresa}**, en "${clasificacion.carpetaSugerida}" — "✅ Sí, ` +
                `archivar aquí" usaría ESO exactamente. Si no es correcto, usa "✏️ Elegir otra carpeta" en vez de confirmar a ciegas.`
            : `No tengo ni siquiera una empresa clara para sugerir — "✅ Sí, archivar aquí" fallaría. Usa "✏️ Elegir ` +
                `otra carpeta" para decírmelo directo.`,
          `También puedes guardarlo como conocimiento en vez de archivo si no es un documento para Drive, o enseñarme ` +
            `una regla una vez que quede claro dónde va.`,
        ].join("\n")
      : [
          `Este documento parece ser de **${clasificacion.empresa}**, tipo **${clasificacion.tipoDocumento}**.`,
          `¿Lo archivo en "${clasificacion.carpetaSugerida}"?`,
          ``,
          `(${clasificacion.razon})`,
        ].join("\n");

  const textoPropuesta = archivo.notaAdjunto ? `${archivo.notaAdjunto}\n\n${textoPropuestaBase}` : textoPropuestaBase;

  const filasBotones = [
    [
      { text: "✅ Sí, archivar aquí", callback_data: `doc_confirm:${propuesta.id}` },
      { text: "✏️ Elegir otra carpeta", callback_data: `doc_reroute:${propuesta.id}` },
    ],
    // Pedido explícito de Carlos, tras un caso real: el análisis solo
    // ofrecía archivar o corregir la carpeta, "no hay forma de enseñarle
    // una regla para el futuro ni crear una alerta". Estos NO consumen
    // la propuesta (a diferencia de los de arriba) — solo la leen, así que
    // "Sí, archivar aquí"/"Elegir otra carpeta" siguen disponibles después.
    [
      { text: "📚 Enseñar regla", callback_data: `doc_regla:${propuesta.id}` },
      { text: "⏰ Crear alerta", callback_data: `doc_alerta:${propuesta.id}` },
    ],
    // Segundo pedido explícito, distinto del anterior: "que me permita
    // decirle que tome este conocimiento y lo integre a su matriz de
    // conocimiento en caso de que se requiera preguntar sobre esto" — a
    // diferencia de "Enseñar regla" (dónde archivar la próxima vez, NO el
    // contenido), esto guarda el CONTENIDO real del documento como
    // conocimiento consultable — mismo flujo de CAPTURA que ya existe para
    // cuando el clasificador detecta la intención automáticamente
    // (pareceIntencionDeCaptura, arriba), pero disponible a pedido en
    // cualquier documento, no solo cuando el caption lo pide explícito.
    [{ text: "🧠 Guardar como conocimiento", callback_data: `doc_conocimiento:${propuesta.id}` }],
    // Tercer pedido explícito de Carlos: siempre debe haber una opción de
    // "no hagas nada con esto" — antes no existía ninguna forma de
    // descartar un documento propuesto (a diferencia de los correos sin
    // adjunto, que sí tienen "❌ Descartar").
    [{ text: "❌ Descartar, no archivar", callback_data: `doc_descartar:${propuesta.id}` }],
  ];

  // Pedido explícito de Carlos, tras un caso real (Footprint, Modelo 303/349 de IVA, 2026-09-17):
  // cuando un correo con adjuntos NO es un gasto, además de archivar debe poder generar una
  // respuesta al correo original — reutiliza ofrecerResponderCorreo (mismo flujo ya usado cuando el
  // clasificador detecta intención de captura), disponible siempre que el documento venga de un
  // correo real. No consume la propuesta — "Sí, archivar aquí" sigue disponible después.
  if (archivo.correoOrigen) {
    filasBotones.push([{ text: "✍️ Generar respuesta al correo", callback_data: `doc_responder:${propuesta.id}` }]);
  }

  // Hallazgo real de auditoría (Footprint, factura Hotel Columbus/Costa Rica, 2026-09-16): este
  // clasificador (solo texto) puede reconocer por contexto que un documento es en realidad un gasto
  // real aunque extraerDatosFactura, leyendo el PDF de verdad, haya decidido lo contrario — antes no
  // había forma de redirigirlo al flujo de gasto desde acá, aunque la propia razón ya lo dijera
  // ("debe procesarse como gasto"). No consume la propuesta — "Sí, archivar aquí" sigue disponible
  // después, por si además quiere archivarlo.
  //
  // Segundo pedido explícito de Carlos (Footprint, hotel APECS Noruega, 2026-09-18): "a todos los
  // botones que me des, siempre, así creas que sea para procesar de manera diferente, inclúyele un
  // botón que dice procesar como gasto... así, si lo procesas mal, lo podemos reencaminar
  // inmediatamente" — ya NO depende de esProbableGasto (una suposición del clasificador de solo
  // texto, que puede fallar): el botón va SIEMPRE, como red de seguridad, sin importar qué tan
  // seguro esté el clasificador de que NO es un gasto.
  filasBotones.splice(1, 0, [{ text: "💰 Es un gasto — procesarlo en Holded", callback_data: `doc_esgasto:${propuesta.id}` }]);

  let messageId = 0;
  try {
    messageId = await sendTelegramMessageWithButtons(archivo.chatId, textoPropuesta, filasBotones);
    await actualizarMessageIdClasificacion(propuesta.id, messageId);
    const confirmada = await obtenerPropuestaClasificacion(propuesta.id);
    if (!confirmada || confirmada.messageId !== messageId) {
      throw new Error("La propuesta se publico, pero no se pudo confirmar su entrega durable.");
    }
  } catch (error) {
    await consumirPropuestaClasificacion(propuesta.id).catch(() => undefined);
    if (messageId > 0) {
      await editTelegramMessage(
        archivo.chatId,
        messageId,
        `⚠️ No pude confirmar esta propuesta de forma durable. El correo sigue sin leer y se reintentara sin usar estos botones.`,
        []
      ).catch(() => undefined);
    }
    throw error;
  }
}

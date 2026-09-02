import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  listarHilosNoLeidos,
  obtenerUltimoMensajeDeHilo,
  obtenerResumenCorreo,
  obtenerCuerpoCompletoCorreo,
  descargarAdjunto,
  marcarHiloComoLeido,
} from "../gmail/client";
import { analizarCorreo } from "../gmail/classifyEmail";
import { guardarUltimoCheck } from "../gmail/lastCheckStore";
import { sendTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";
import { procesarDocumentoLocal } from "../documental/procesarDocumentoLocal";
import { crearPropuestaAccionCorreo, actualizarMessageIdAccionCorreo } from "../gmail/emailActionStore";
import { registrarPersonaDesdeCorreo } from "../directorio/directorioPersonasSheet";
import {
  encolarCorreos,
  hayActivo,
  contarPendientesTotal,
  iniciarSiguienteActivo,
  establecerPendientesActivo,
  resolverUnoActivo,
  obtenerActivoEstancado,
  descartarActivoEstancado,
} from "../gmail/colaRevisionStore";

// 48h — mismo criterio que classificationStore.ts (48h) y otras propuestas
// "principales" del sistema: suficiente margen para un día de trabajo largo
// o una respuesta demorada, sin dejar la cola trabada indefinidamente.
const UMBRAL_ACTIVO_ESTANCADO_MS = 48 * 60 * 60 * 1000;

const UPLOADS_DIR = join(process.cwd(), "tmp", "uploads");

function sanitizarNombre(nombre: string): string {
  return nombre.replace(/[^\w.\-]+/g, "_").slice(0, 150);
}

/**
 * Pedido explícito de Carlos, tras un caso real: cuando revisaba el correo,
 * el sistema mandaba una propuesta por CADA correo nuevo de la misma
 * pasada — con varios correos a la vez, eso eran varias propuestas de golpe
 * ("necesitamos organizar este proceso"). Ahora, en vez de procesar todo de
 * una, esta función solo ENCOLA (core/gmail/colaRevisionStore.ts) los
 * correos sin leer nuevos — del más antiguo al más nuevo — y, si no hay
 * ningún correo "activo" en este momento (nada mostrado esperando
 * resolución), arranca con el más antiguo. El resto de la cola se procesa
 * de a uno, avanzando solo cuando cada correo se resuelve en el chat (ver
 * avanzarColaCorreoSiActivo, llamado desde los botones de acción/captura/
 * clasificación de documento/gasto ya existentes en el resto del sistema).
 *
 * A diferencia de antes, la fuente de verdad de "correo nuevo" es is:unread
 * real de Gmail, por HILO (listarHilosNoLeidos), no una marca de tiempo
 * propia ni un conteo por mensaje individual — así
 * "cuántos correos sin leer quedan" siempre refleja el estado real de la
 * bandeja, y un correo que Carlos ya leyó a mano en Gmail no vuelve a
 * aparecer en la cola.
 */
export async function revisarCorreoNuevo(): Promise<{ correosRevisados: number }> {
  const chatId = process.env.CASHFLOW_ALERTS_CHAT_ID ? Number(process.env.CASHFLOW_ALERTS_CHAT_ID) : undefined;

  if (!chatId) {
    console.error("[revisarCorreoNuevo] Falta CASHFLOW_ALERTS_CHAT_ID, no se puede notificar.");
    return { correosRevisados: 0 };
  }

  // Antes de encolar nada: si el correo activo lleva más de 48h esperando
  // algo que nunca llegó (una pregunta de desambiguación vencida, una
  // corrección de gasto que se quedó a medias...), lo salta con aviso en
  // vez de dejar toda la cola bloqueada detrás de él indefinidamente — ver
  // obtenerActivoEstancado.
  const estancado = await obtenerActivoEstancado(chatId, UMBRAL_ACTIVO_ESTANCADO_MS).catch((error) => {
    console.error("[revisarCorreoNuevo] Error revisando si el correo activo está estancado:", error);
    return undefined;
  });
  if (estancado) {
    await descartarActivoEstancado(chatId, estancado.id).catch((error) =>
      console.error("[revisarCorreoNuevo] Error descartando correo activo estancado:", error)
    );
    await sendTelegramMessage(
      chatId,
      `⚠️ "${estancado.asunto}" (de ${estancado.de}) llevaba más de 48h abierto sin resolverse — lo salto para no ` +
        `trabar el resto de la cola. Sigue sin marcar como leído en Gmail; revísalo a mano si todavía hace falta.`
    ).catch(() => {});
    await procesarSiguienteCorreoActivo(chatId);
  }

  let ids: string[] = [];
  try {
    ids = await listarHilosNoLeidos();
  } catch (error) {
    console.error("[revisarCorreoNuevo] Error listando hilos sin leer:", error);
    return { correosRevisados: 0 };
  }

  console.log(`[revisarCorreoNuevo] ${ids.length} hilo(s) sin leer en la bandeja`);

  // Ya no se usa para filtrar (is:unread real reemplazó la ventana de
  // tiempo) — se guarda solo para que estadoAgregado.ts (panel /cerebro)
  // pueda mostrar "última vez que se revisó el correo" sin quedar
  // congelado en el valor de antes de este cambio.
  guardarUltimoCheck(Math.floor(Date.now() / 1000)).catch((error) =>
    console.error("[revisarCorreoNuevo] Error guardando el último check (no crítico):", error)
  );

  if (ids.length === 0) return { correosRevisados: 0 };

  const [habiaActivoAntes, totalAntesDeEncolar] = await Promise.all([hayActivo(chatId), contarPendientesTotal(chatId)]);

  const itemsParaEncolar: Array<{ id: string; mensajeId: string; de: string; asunto: string; fechaOrden: number }> = [];
  for (const threadId of ids) {
    try {
      const ultimo = await obtenerUltimoMensajeDeHilo(threadId);
      if (!ultimo) continue;
      const fechaOrden = Date.parse(ultimo.fecha);
      itemsParaEncolar.push({
        id: threadId,
        mensajeId: ultimo.messageId,
        de: ultimo.de,
        asunto: ultimo.asunto || "(sin asunto)",
        fechaOrden: Number.isFinite(fechaOrden) ? fechaOrden : Date.now(),
      });
    } catch (error) {
      console.error(`[revisarCorreoNuevo] Error leyendo metadatos del hilo ${threadId} (se omite de la cola):`, error);
    }
  }

  const nuevos = await encolarCorreos(chatId, itemsParaEncolar);
  if (nuevos === 0) return { correosRevisados: 0 };

  // Pedido explícito de Carlos: el aviso de "tienes correos nuevos" es solo
  // al EMPEZAR una revisión desde cero — si ya hay un backlog en curso
  // (algo activo o en cola de una corrida anterior), los nuevos se suman en
  // silencio a la cola en vez de interrumpir con otro aviso cada hora.
  if (totalAntesDeEncolar === 0) {
    await sendTelegramMessage(
      chatId,
      `📬 Tienes ${nuevos} correo${nuevos === 1 ? "" : "s"} nuevo${nuevos === 1 ? "" : "s"} sin leer. Empezamos por el más antiguo:`
    ).catch((error) => console.error("[revisarCorreoNuevo] Error avisando de correos nuevos:", error));
  }

  if (!habiaActivoAntes) {
    await procesarSiguienteCorreoActivo(chatId);
  }

  return { correosRevisados: nuevos };
}

/**
 * Procesa el correo que acaba de pasar a "activo" en la cola (el más
 * antiguo pendiente) — mismo análisis por correo que existía antes
 * (adjuntos → clasificación de documento/gasto; necesita respuesta/
 * instrucción del jefe → propuesta con botones; notas de reunión/
 * informativo → captura), pero para UNO solo, fijando cuántas decisiones
 * hacen falta para darlo por resuelto (ver establecerPendientesActivo) antes
 * de mandar la(s) propuesta(s). Si algo se rompe antes de llegar a mandar
 * ninguna propuesta, se resuelve igual (con aviso) para no dejar la cola
 * trabada en un correo roto para siempre.
 */
export async function procesarSiguienteCorreoActivo(chatId: number): Promise<void> {
  const activo = await iniciarSiguienteActivo(chatId);
  if (!activo) return; // cola vacía — nada más que revisar.

  try {
    const correo = await obtenerResumenCorreo(activo.mensajeId);

    // No crítico — nunca debe bloquear el procesamiento real del correo.
    registrarPersonaDesdeCorreo(correo.de, "correo_entrante").catch((error) =>
      console.error("[revisarCorreoNuevo] Error registrando remitente en el directorio de personas:", error)
    );

    // Pedido explícito de Carlos: analizar el direccionamiento de CADA
    // correo (qué acción hay que tomar, y si el camino está claro,
    // proponerlo directo; si no, preguntar) — nunca dejar caer un correo
    // con adjunto real sin acción. Si trae adjuntos reales, SIEMPRE se
    // procesan con el mismo clasificador robusto de documentos
    // (procesarDocumentoLocal — el mismo que usa Telegram), que YA decide
    // el camino (Drive, Holded como gasto, o ambigüedad a preguntar) sin
    // depender de que el clasificador liviano de correo haya acertado el
    // tipo. Cada adjunto es su propia decisión independiente — un correo
    // con 3 adjuntos necesita 3 resoluciones antes de darse por leído.
    if (correo.adjuntos.length > 0) {
      await establecerPendientesActivo(chatId, activo.id, correo.adjuntos.length);
      for (const adjunto of correo.adjuntos) {
        try {
          const bytes = await descargarAdjunto(correo.id, adjunto.attachmentId);
          await mkdir(UPLOADS_DIR, { recursive: true });

          const nombreArchivo = `${Date.now()}_${sanitizarNombre(adjunto.filename)}`;
          const destino = join(UPLOADS_DIR, nombreArchivo);
          await writeFile(destino, bytes);

          await procesarDocumentoLocal({
            chatId,
            rutaLocal: destino,
            nombreArchivoOriginal: adjunto.filename,
            mimeType: adjunto.mimeType,
            nombreParaClasificar: adjunto.filename,
            captionEfectivo: `Adjunto de correo. De: ${correo.de}. Asunto: ${correo.asunto}. ${correo.extracto}`,
            // deColaCorreo: true — permite a documentCallbackHandler.ts y
            // gastoCallbackHandler.ts distinguir esta propuesta (que sí debe
            // avanzar la cola de revisión al resolverse) de una propuesta
            // creada por CUALQUIER otro camino no relacionado (una foto
            // subida por Telegram, capturar_correo bajo demanda...) — bug
            // real encontrado en auditoría: sin este marcador, resolver
            // CUALQUIER propuesta de gasto/documento en el mismo chat hacía
            // avanzar/marcar-como-leído el correo activo de esta cola,
            // aunque no tuviera ninguna relación real con él.
            correoOrigen: {
              de: correo.de,
              asunto: correo.asunto || "(sin asunto)",
              threadId: correo.threadId,
              messageIdHeader: correo.messageIdHeader,
              deColaCorreo: true,
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[revisarCorreoNuevo] Error procesando adjunto "${adjunto.filename}":`, message);
          // Este adjunto nunca mandó ninguna propuesta — nada lo va a
          // resolver por su cuenta, así que se resuelve acá mismo (con
          // aviso) para no dejar la cola trabada esperando algo que nunca va a llegar.
          await sendTelegramMessage(
            chatId,
            `⚠️ Hubo un error leyendo el adjunto "${adjunto.filename}" de "${correo.asunto}" — lo salto.`
          ).catch(() => {});
          await avanzarColaCorreoSiActivo(chatId);
        }
      }
      return;
    }

    // Pedido explícito de Carlos, tras un caso real ("no sé darte respuesta
    // porque no sé de qué MAIL me hablas" / "debes leer todos y cada uno de
    // los mails, así podrás preguntar qué hacer con la información...si es
    // para hacer un gasto, si es para guardar la información, si es para
    // dejarlo en tu base de conocimiento, si es para guardar un archivo, si
    // es para mandar un correo, si es para guardar una alerta"): TODO correo
    // sin adjunto pasa por el mismo análisis con el CUERPO COMPLETO (no solo
    // el extracto), y recibe el MISMO tratamiento sin importar su tipo —
    // antes notas_reunion iba directo a "¿qué empresa?" sin decir de qué
    // correo se trataba, e informativo tenía su propia pregunta binaria
    // aparte; ahora es una sola propuesta con resumen real + acción concreta
    // sugerida + 4 opciones, igual que ya funcionaba bien para
    // necesita_respuesta/instruccion_jefe.
    await establecerPendientesActivo(chatId, activo.id, 1);

    const cuerpoCompleto = await obtenerCuerpoCompletoCorreo(correo.id).catch((error) => {
      console.error(`[revisarCorreoNuevo] Error leyendo el cuerpo completo de ${correo.id} (se analiza con lo que haya):`, error);
      return "";
    });

    const analisis = await analizarCorreo(correo, cuerpoCompleto);

    const propuesta = await crearPropuestaAccionCorreo({
      chatId,
      messageId: 0,
      de: correo.de,
      asunto: correo.asunto || "(sin asunto)",
      tipo: analisis.tipo,
      resumen: analisis.resumen,
      accionSugerida: analisis.accionSugerida,
      threadId: correo.threadId,
      messageIdHeader: correo.messageIdHeader,
      mensajeId: correo.id,
    });

    const texto = [`📧 *${propuesta.asunto}*`, `De: ${propuesta.de}`, propuesta.resumen, `→ ${propuesta.accionSugerida}`].join(
      "\n"
    );

    const messageId = await sendTelegramMessageWithButtons(chatId, texto, [
      [
        { text: "✅ Proceder", callback_data: `email_proceder:${propuesta.id}` },
        { text: "🧠 Guardar como conocimiento", callback_data: `email_guardar:${propuesta.id}` },
      ],
      [
        { text: "❌ Descartar", callback_data: `email_descartar:${propuesta.id}` },
        { text: "✏️ Dar instrucciones específicas", callback_data: `email_orientar:${propuesta.id}` },
      ],
    ]);

    await actualizarMessageIdAccionCorreo(propuesta.id, messageId);
  } catch (error) {
    console.error(`[revisarCorreoNuevo] Error procesando correo activo ${activo.id}:`, error);
    await sendTelegramMessage(chatId, `⚠️ Hubo un error revisando un correo ("${activo.asunto}") — lo salto y sigo con el siguiente.`).catch(
      () => {}
    );
    await establecerPendientesActivo(chatId, activo.id, 1);
    await avanzarColaCorreoSiActivo(chatId);
  }
}

/**
 * Señal genérica de "algo se resolvió para el correo activo de este chat,
 * si lo hay" — pensada para llamarse desde CUALQUIER punto terminal ya
 * existente del sistema (doc_confirm, doc_reroute, gasto_adjuntar/nuevo/
 * cancelar, email_proceder/descartar, continuarConOrientacion,
 * capturaempresa_confirmar/cancelar, correoinfo_siguiente) sin que ese
 * código necesite saber si en verdad hay una revisión de correo en curso:
 * si no hay ningún correo activo para este chat (el caso normal, la
 * inmensa mayoría de acciones NO vienen de esta cola), esto no hace nada.
 * Cuando el correo activo queda resuelto (pendientesRestantes llega a 0),
 * lo marca como leído en Gmail y sigue con el siguiente de la cola — o
 * avisa que ya no queda ninguno.
 */
export async function avanzarColaCorreoSiActivo(chatId: number): Promise<void> {
  const resultado = await resolverUnoActivo(chatId).catch((error) => {
    console.error("[revisarCorreoNuevo] Error avanzando la cola de revisión de correo (no crítico):", error);
    return { terminado: false as const };
  });

  if (!resultado.terminado) return;

  if (resultado.gmailIdResuelto) {
    marcarHiloComoLeido(resultado.gmailIdResuelto).catch((error: unknown) =>
      console.error("[revisarCorreoNuevo] Error marcando el hilo como leído (no crítico):", error)
    );
  }

  const quedan = await contarPendientesTotal(chatId);
  if (quedan === 0) {
    await sendTelegramMessage(chatId, "✅ Ya no quedan correos sin leer por resolver — al día.").catch(() => {});
    return;
  }

  await procesarSiguienteCorreoActivo(chatId);
}

/**
 * Pedido explícito de Carlos: al final del día (7pm), si todavía queda algo
 * sin resolver en la cola de revisión de correo, avisa cuántos — para que
 * sepa el tamaño real del backlog sin tener que contarlo él mismo. No avisa
 * nada si ya está al día (quedan 0).
 */
export async function avisarPendientesCorreo7pm(): Promise<void> {
  const chatId = process.env.CASHFLOW_ALERTS_CHAT_ID ? Number(process.env.CASHFLOW_ALERTS_CHAT_ID) : undefined;
  if (!chatId) return;

  const quedan = await contarPendientesTotal(chatId);
  if (quedan === 0) return;

  await sendTelegramMessage(
    chatId,
    `🕖 Fin del día — quedan ${quedan} correo${quedan === 1 ? "" : "s"} sin leer por resolver.`
  ).catch((error) => console.error("[revisarCorreoNuevo] Error mandando el aviso de las 7pm:", error));
}

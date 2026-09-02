import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  listarNoLeidos,
  obtenerResumenCorreo,
  obtenerCuerpoCompletoCorreo,
  descargarAdjunto,
  marcarCorreoComoLeido,
  type CorreoResumen,
} from "../gmail/client";
import { analizarCorreo, evaluarCorreoInformativo } from "../gmail/classifyEmail";
import { sendTelegramMessage, sendTelegramMessageWithButtons, editTelegramMessage, answerCallbackQuery } from "../telegram/client";
import { procesarDocumentoLocal } from "../documental/procesarDocumentoLocal";
import { crearPropuestaAccionCorreo, actualizarMessageIdAccionCorreo } from "../gmail/emailActionStore";
import { iniciarSeleccionEmpresaCaptura } from "../knowledge/capturaEmpresaCallbackHandler";
import { registrarPersonaDesdeCorreo } from "../directorio/directorioPersonasSheet";
import {
  encolarCorreos,
  hayActivo,
  contarPendientesTotal,
  iniciarSiguienteActivo,
  establecerPendientesActivo,
  resolverUnoActivo,
} from "../gmail/colaRevisionStore";
import type { TelegramCallbackQuery } from "../telegram/types";

const UPLOADS_DIR = join(process.cwd(), "tmp", "uploads");

function sanitizarNombre(nombre: string): string {
  return nombre.replace(/[^\w.\-]+/g, "_").slice(0, 150);
}

// Detección por asunto — confirmada en vivo contra un correo real de
// Gemini/Google Meet (reenviado por Carlos): asunto exacto 'Notas: "Rental
// CO, gestión administrativa y contable", 27 ago 2026' (o con "Fwd: " si se
// reenvía). No se puede confiar en el clasificador de IA para este caso: el
// `extracto` (snippet de Gmail) de un correo reenviado es el inicio del
// cuerpo — normalmente la firma de quien reenvía, NO el contenido real de
// las notas, así que el snippet no trae ninguna señal de que sea Gemini.
// "Notes by Gemini:" queda como variante en inglés (documentada por Google,
// no confirmada en vivo todavía).
const PATRON_ASUNTO_NOTAS_REUNION = /^(Fwd:\s*)?(Notas:|Notes by Gemini:)/i;

function pareceAsuntoDeNotasReunion(asunto: string): boolean {
  return PATRON_ASUNTO_NOTAS_REUNION.test(asunto.trim());
}

/**
 * Lee el cuerpo completo de un correo de notas de reunión y dispara el
 * mismo flujo de CAPTURA con botones de empresa que un CAPTURA normal
 * (nunca se guarda hasta que alguien confirme — ver
 * core/knowledge/capturaEmpresaCallbackHandler.ts). Se usa tanto desde la
 * detección directa por asunto como desde el clasificador de IA.
 */
async function capturarNotasDeReunion(chatId: number, correo: CorreoResumen): Promise<void> {
  try {
    const cuerpo = await obtenerCuerpoCompletoCorreo(correo.id);
    const contenido = [`De: ${correo.de}`, `Asunto: ${correo.asunto}`, `Fecha: ${correo.fecha}`, "", cuerpo].join("\n");
    await iniciarSeleccionEmpresaCaptura(chatId, contenido, `notas de reunión (${correo.de})`);
  } catch (error) {
    console.error(`[revisarCorreoNuevo] Error capturando notas de reunión del correo ${correo.id}:`, error);
    await sendTelegramMessage(
      chatId,
      `⚠️ Llegaron notas de reunión ("${correo.asunto}") pero hubo un error leyéndolas — revísalo manualmente en el correo.`
    );
  }
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
 * real de Gmail (listarNoLeidos), no una marca de tiempo propia — así
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

  let ids: string[] = [];
  try {
    ids = await listarNoLeidos();
  } catch (error) {
    console.error("[revisarCorreoNuevo] Error listando mensajes sin leer:", error);
    return { correosRevisados: 0 };
  }

  console.log(`[revisarCorreoNuevo] ${ids.length} correo(s) sin leer en la bandeja`);

  if (ids.length === 0) return { correosRevisados: 0 };

  const habiaActivoAntes = await hayActivo(chatId);
  const totalAntesDeEncolar = await contarPendientesTotal(chatId);

  const itemsParaEncolar: Array<{ id: string; de: string; asunto: string; fechaOrden: number }> = [];
  for (const id of ids) {
    try {
      const correo = await obtenerResumenCorreo(id);
      const fechaOrden = Date.parse(correo.fecha);
      itemsParaEncolar.push({
        id,
        de: correo.de,
        asunto: correo.asunto || "(sin asunto)",
        fechaOrden: Number.isFinite(fechaOrden) ? fechaOrden : Date.now(),
      });
    } catch (error) {
      console.error(`[revisarCorreoNuevo] Error leyendo metadatos de ${id} (se omite de la cola):`, error);
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
    const correo = await obtenerResumenCorreo(activo.id);

    // No crítico — nunca debe bloquear el procesamiento real del correo.
    registrarPersonaDesdeCorreo(correo.de, "correo_entrante").catch((error) =>
      console.error("[revisarCorreoNuevo] Error registrando remitente en el directorio de personas:", error)
    );

    // Chequeo directo por asunto ANTES de gastar una llamada a Claude —
    // más barato y más confiable que depender del clasificador para este
    // caso específico (ver nota en pareceAsuntoDeNotasReunion).
    if (pareceAsuntoDeNotasReunion(correo.asunto)) {
      await establecerPendientesActivo(chatId, activo.id, 1);
      await capturarNotasDeReunion(chatId, correo);
      return;
    }

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
            correoOrigen: {
              de: correo.de,
              asunto: correo.asunto || "(sin asunto)",
              threadId: correo.threadId,
              messageIdHeader: correo.messageIdHeader,
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

    const analisis = await analizarCorreo(correo);

    if (analisis.tipo === "notas_reunion") {
      await establecerPendientesActivo(chatId, activo.id, 1);
      await capturarNotasDeReunion(chatId, correo);
      return;
    }

    if (analisis.tipo === "necesita_respuesta" || analisis.tipo === "instruccion_jefe") {
      await establecerPendientesActivo(chatId, activo.id, 1);

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
      });

      const texto = [
        `📧 *${propuesta.asunto}*`,
        `De: ${propuesta.de}`,
        `Tipo: ${propuesta.tipo}`,
        propuesta.resumen,
        `→ ${propuesta.accionSugerida}`,
      ].join("\n");

      const messageId = await sendTelegramMessageWithButtons(chatId, texto, [
        [
          { text: "✅ Proceder", callback_data: `email_proceder:${propuesta.id}` },
          { text: "❌ Descartar", callback_data: `email_descartar:${propuesta.id}` },
        ],
        [{ text: "✏️ Dar instrucciones específicas", callback_data: `email_orientar:${propuesta.id}` }],
      ]);

      await actualizarMessageIdAccionCorreo(propuesta.id, messageId);
      return;
    }

    // informativo (o cualquier otro caso sin acción concreta) — pedido
    // explícito de Carlos: el resumen debe decir de qué trata el correo de
    // verdad (no repetir el asunto), y SIEMPRE debe quedar la opción de
    // guardarlo como conocimiento a mano ("puede ser que integres la
    // información de este correo a tu conocimiento para próximas
    // consultas") aunque el evaluador automático decida que no vale la
    // pena — nunca decide en su nombre.
    await establecerPendientesActivo(chatId, activo.id, 1);

    let resumenInformativo = analisis.resumen;
    let cuerpoCompleto = "";
    let valeLaPenaGuardar = false;
    let razonGuardar: string | undefined;
    try {
      cuerpoCompleto = await obtenerCuerpoCompletoCorreo(correo.id);
      const evaluacion = await evaluarCorreoInformativo(correo.asunto || "(sin asunto)", cuerpoCompleto);
      resumenInformativo = evaluacion.resumen;
      valeLaPenaGuardar = evaluacion.valeLaPenaGuardar;
      razonGuardar = evaluacion.razonGuardar;
    } catch (error) {
      console.error(`[revisarCorreoNuevo] Error evaluando el cuerpo de ${activo.id} (uso el resumen original):`, error);
    }

    if (valeLaPenaGuardar && cuerpoCompleto) {
      const contenido = [`De: ${correo.de}`, `Asunto: ${correo.asunto}`, `Fecha: ${correo.fecha}`, "", cuerpoCompleto].join(
        "\n"
      );
      const intro = `📧 Encontré algo que puede valer la pena recordar en un correo de ${correo.de} (asunto: "${correo.asunto}"): ${razonGuardar || resumenInformativo}`;
      await iniciarSeleccionEmpresaCaptura(chatId, contenido, `correo informativo (${correo.de})`, intro);
      return;
    }

    const texto = [`📧 *${correo.asunto || "(sin asunto)"}*`, `De: ${correo.de}`, resumenInformativo, "", "Sin acción requerida — ¿lo guardo como conocimiento igual?"].join(
      "\n"
    );
    await sendTelegramMessageWithButtons(chatId, texto, [
      [
        { text: "🧠 Guardar como conocimiento", callback_data: `correoinfo_guardar:${activo.id}` },
        { text: "➡️ Siguiente, no hace falta", callback_data: `correoinfo_siguiente:${activo.id}` },
      ],
    ]);
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
    marcarCorreoComoLeido(resultado.gmailIdResuelto).catch((error) =>
      console.error("[revisarCorreoNuevo] Error marcando correo como leído (no crítico):", error)
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
 * Botones de un correo puramente informativo sin nada que valga la pena
 * guardar según el evaluador automático — "🧠 Guardar como conocimiento" usa
 * el mismo flujo de selección de empresa de siempre (nunca se guarda sin
 * confirmar); "➡️ Siguiente" avanza la cola sin guardar nada.
 */
export async function handleCorreoInfoCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  const chatId = callback.message?.chat.id;
  const messageId = callback.message?.message_id;
  if (!data || !chatId || !messageId) {
    await answerCallbackQuery(callback.id).catch(() => {});
    return;
  }

  const [accion, gmailId] = data.split(":");

  if (accion === "correoinfo_siguiente") {
    await answerCallbackQuery(callback.id, "Ok, siguiente.").catch(() => {});
    await editTelegramMessage(chatId, messageId, "➡️ Sin acción — marcado como leído.", []).catch(() => {});
    await avanzarColaCorreoSiActivo(chatId);
    return;
  }

  if (accion === "correoinfo_guardar") {
    await answerCallbackQuery(callback.id, "Leyendo el correo...").catch(() => {});
    try {
      const correo = await obtenerResumenCorreo(gmailId);
      const cuerpo = await obtenerCuerpoCompletoCorreo(gmailId);
      const contenido = [`De: ${correo.de}`, `Asunto: ${correo.asunto}`, `Fecha: ${correo.fecha}`, "", cuerpo].join("\n");
      await editTelegramMessage(chatId, messageId, "🧠 Guardando como conocimiento — elige la empresa abajo.", []).catch(() => {});
      await iniciarSeleccionEmpresaCaptura(chatId, contenido, `correo informativo (${correo.de})`);
    } catch (error) {
      console.error("[revisarCorreoNuevo] Error preparando la captura de un correo informativo:", error);
      await sendTelegramMessage(chatId, "⚠️ No pude leer el correo para guardarlo como conocimiento.").catch(() => {});
      await avanzarColaCorreoSiActivo(chatId);
    }
  }
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

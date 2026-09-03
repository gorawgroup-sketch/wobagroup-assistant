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
import { extraerGastoDeCorreo } from "../gmail/extraerGastoDeCorreo";
import { generarComprobantePDF } from "../gmail/generarComprobantePDF";
import { guardarUltimoCheck } from "../gmail/lastCheckStore";
import { sendTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";
import { procesarDocumentoLocal } from "../documental/procesarDocumentoLocal";
import { procesarGastoEntrante } from "../gastos/procesarGastoEntrante";
import type { DatosFactura } from "../documental/extractInvoiceData";
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
  obtenerActivoActual,
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
export interface ResultadoRevisarCorreo {
  correosRevisados: number;
  /**
   * Cuando correosRevisados=0 porque ya había un correo "activo" sin
   * resolver (no porque no hubiera nada pendiente) — para que el llamador
   * (comando manual /revisarcorreo) pueda avisar QUÉ es lo que está
   * bloqueando, en vez de decir "0 correos revisados" sin explicación.
   * Pedido explícito de Carlos, tras un caso real: pidió /revisarcorreo con
   * varios correos reales sin leer, y el sistema respondió así sin ninguna
   * pista de que la causa real era una pregunta de conciliación pendiente
   * desde horas antes.
   */
  activoBloqueando?: { asunto: string; de: string };
}

export async function revisarCorreoNuevo(): Promise<ResultadoRevisarCorreo> {
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
    ids = [];
  }

  console.log(`[revisarCorreoNuevo] ${ids.length} hilo(s) sin leer en la bandeja`);

  // Ya no se usa para filtrar (is:unread real reemplazó la ventana de
  // tiempo) — se guarda solo para que estadoAgregado.ts (panel /cerebro)
  // pueda mostrar "última vez que se revisó el correo" sin quedar
  // congelado en el valor de antes de este cambio.
  guardarUltimoCheck(Math.floor(Date.now() / 1000)).catch((error) =>
    console.error("[revisarCorreoNuevo] Error guardando el último check (no crítico):", error)
  );

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

  const nuevos = itemsParaEncolar.length > 0 ? await encolarCorreos(chatId, itemsParaEncolar) : 0;

  // Pedido explícito de Carlos: el aviso de "tienes correos nuevos" es solo
  // al EMPEZAR una revisión desde cero — si ya hay un backlog en curso
  // (algo activo o en cola de una corrida anterior), los nuevos se suman en
  // silencio a la cola en vez de interrumpir con otro aviso cada hora.
  if (nuevos > 0 && totalAntesDeEncolar === 0) {
    await sendTelegramMessage(
      chatId,
      `📬 Tienes ${nuevos} correo${nuevos === 1 ? "" : "s"} nuevo${nuevos === 1 ? "" : "s"} sin leer. Empezamos por el más antiguo:`
    ).catch((error) => console.error("[revisarCorreoNuevo] Error avisando de correos nuevos:", error));
  }

  // Bug real encontrado en vivo: esto antes vivía DENTRO del `if (nuevos ===
  // 0) return` de arriba — un "revisarcorreo" manual con la cola ya llena
  // pero SIN nada "activo" (ej. justo después de resetear un correo
  // atascado) no encontraba nada NUEVO que encolar, así que la función
  // terminaba ahí ("0 correos revisados") sin nunca retomar lo que ya
  // estaba esperando. Ahora, sin importar si esta corrida encontró algo
  // nuevo, si no hay nada activo y sí hay algo pendiente (nuevo o de antes),
  // se retoma.
  if (!habiaActivoAntes && totalAntesDeEncolar + nuevos > 0) {
    await procesarSiguienteCorreoActivo(chatId);
    return { correosRevisados: nuevos };
  }

  if (habiaActivoAntes) {
    const activo = await obtenerActivoActual(chatId).catch(() => undefined);
    if (activo) {
      return { correosRevisados: nuevos, activoBloqueando: { asunto: activo.asunto, de: activo.de } };
    }
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

          const resultadoDocumento = await procesarDocumentoLocal({
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
              // Causa raíz real, encontrada en vivo: un gasto se creó en
              // Holded SIN su comprobante ("ENOENT: no such file or
              // directory, open '/app/tmp/uploads/...'") — el archivo local
              // no sobrevive un redeploy de Railway, pero la propuesta en
              // Sheets sí, así que un adjunto que queda pendiente durante
              // CUALQUIER redeploy (frecuente en desarrollo activo, y ahora
              // más probable con los TTLs largos de hoy) pierde su copia de
              // trabajo aunque el original siga intacto en Gmail. Guardar el
              // messageId+attachmentId reales permite volver a descargarlo
              // de la fuente durable si la copia local desaparece (ver
              // reDescargarAdjuntoSiFalta.ts).
              mensajeIdGmail: correo.id,
              attachmentIdGmail: adjunto.attachmentId,
            },
          });

          // Bug real encontrado en vivo: cuando procesarDocumentoLocal
          // detecta que ya hay una propuesta de "Crear gasto" pendiente para
          // la misma factura (ver buscarPropuestaGastoPendiente), no manda
          // ninguna propuesta NUEVA con botones — así que nada más iba a
          // resolver este "pendiente" de la cola, dejándolo trabado
          // esperando algo que nunca iba a llegar. Se avanza acá mismo,
          // igual que el resto de los caminos que terminan sin mandar
          // ninguna propuesta real (ver el catch de abajo).
          if (resultadoDocumento === "gasto_duplicado") {
            await avanzarColaCorreoSiActivo(chatId);
          }
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

    // Pedido explícito de Carlos, tras un caso real: un correo sin adjunto
    // puede describir un gasto real igual que uno con adjunto (ej. una
    // notificación de tarjeta pegada como texto/HTML en el cuerpo, sin
    // ningún PDF/imagen real) — "solo te das cuenta si es un gasto cuando no
    // tiene anexo... si lees todos los correos, cuando lo leas identificas,
    // me preguntas". Antes de caer al análisis genérico, se intenta leer el
    // cuerpo como gasto exactamente con el mismo criterio que un adjunto
    // real (mismo patrón que procesarDocumentoLocal.ts: primero factura/
    // gasto, si no lo es cae al camino normal). Si sí es un gasto, se genera
    // un PDF con los datos + el cuerpo completo como comprobante (no hay
    // ningún archivo real que adjuntar) y sigue por el MISMO camino que un
    // adjunto real (procesarGastoEntrante) — reutiliza tal cual el matching
    // de Holded/banco, la moneda equivalente, y la pregunta de conciliar,
    // sin duplicar nada de esa lógica.
    let gastoDetectado: DatosFactura | undefined;
    try {
      gastoDetectado = await extraerGastoDeCorreo(cuerpoCompleto, {
        de: correo.de,
        asunto: correo.asunto,
        fecha: correo.fecha,
      });
    } catch (error) {
      console.error(`[revisarCorreoNuevo] Error intentando leer el correo ${correo.id} como gasto (sigue como correo normal):`, error);
    }

    if (gastoDetectado?.esFacturaOGasto) {
      try {
        const bytes = await generarComprobantePDF(
          { de: correo.de, asunto: correo.asunto, fecha: correo.fecha, cuerpoCompleto },
          gastoDetectado
        );
        await mkdir(UPLOADS_DIR, { recursive: true });
        const nombreArchivo = `${Date.now()}_comprobante_${sanitizarNombre(correo.asunto || "correo")}.pdf`;
        const destino = join(UPLOADS_DIR, nombreArchivo);
        await writeFile(destino, bytes);

        // Nota honesta en el concepto — para que la propuesta que ve Carlos
        // deje claro que el "comprobante" es un PDF generado a partir del
        // cuerpo, no el recibo original, sin tocar procesarGastoEntrante.ts.
        const datosConNota: DatosFactura = {
          ...gastoDetectado,
          concepto: gastoDetectado.concepto
            ? `${gastoDetectado.concepto} (comprobante generado desde el cuerpo del correo, sin adjunto original)`
            : "Gasto detectado en el cuerpo del correo (sin adjunto original)",
        };

        await procesarGastoEntrante({
          chatId,
          rutaLocal: destino,
          nombreArchivoOriginal: nombreArchivo,
          mimeType: "application/pdf",
          datos: datosConNota,
          deColaCorreo: true,
        });
        return;
      } catch (error) {
        console.error(`[revisarCorreoNuevo] Error generando la propuesta de gasto desde el cuerpo del correo ${correo.id} (sigue como correo normal):`, error);
        // Cae al análisis genérico de abajo en vez de perder el correo —
        // mejor preguntar de forma genérica que no decir nada.
      }
    }

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


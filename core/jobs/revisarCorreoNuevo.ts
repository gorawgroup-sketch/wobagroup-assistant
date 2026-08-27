import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  listarMensajesNuevos,
  obtenerResumenCorreo,
  obtenerCuerpoCompletoCorreo,
  descargarAdjunto,
  type CorreoResumen,
} from "../gmail/client";
import { obtenerUltimoCheck, guardarUltimoCheck } from "../gmail/lastCheckStore";
import { analizarCorreo } from "../gmail/classifyEmail";
import { sendTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";
import { manejarClasificacion } from "../documental/processClassification";
import { extraerDatosFactura } from "../documental/extractInvoiceData";
import { procesarGastoEntrante } from "../gastos/procesarGastoEntrante";
import { crearPropuestaAccionCorreo, actualizarMessageIdAccionCorreo } from "../gmail/emailActionStore";
import { iniciarSeleccionEmpresaCaptura } from "../knowledge/capturaEmpresaCallbackHandler";
import { registrarPersonaDesdeCorreo } from "../directorio/directorioPersonasSheet";

const UPLOADS_DIR = join(process.cwd(), "tmp", "uploads");

const MIMES_LEGIBLES_COMO_FACTURA = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"];

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
 * Fase 1 del módulo de correo: revisa TODOS los correos nuevos de la
 * bandeja de entrada desde la última revisión, los clasifica, y:
 * - si traen un documento archivable, lo descarga y lo manda por el MISMO
 *   flujo de clasificación/aprobación ya existente para archivos de
 *   Telegram (nunca se sube a Drive sin aprobación explícita).
 * - si necesitan respuesta o parecen una instrucción del jefe, manda una
 *   propuesta individual con botones "✅ Proceder / ❌ Descartar / ✏️ Dar
 *   instrucciones" — "Proceder" nunca ejecuta el texto del correo
 *   directamente, dispara al asistente normal con sus tools ya existentes.
 * - los correos puramente informativos se agrupan en un solo resumen.
 * NUNCA responde correos por su cuenta, NUNCA ejecuta instrucciones del
 * correo sin que el usuario apruebe explícitamente por botón.
 */
export async function revisarCorreoNuevo(): Promise<{ correosRevisados: number }> {
  const chatId = process.env.CASHFLOW_ALERTS_CHAT_ID ? Number(process.env.CASHFLOW_ALERTS_CHAT_ID) : undefined;

  if (!chatId) {
    console.error("[revisarCorreoNuevo] Falta CASHFLOW_ALERTS_CHAT_ID, no se puede notificar.");
    return { correosRevisados: 0 };
  }

  const desde = await obtenerUltimoCheck();
  const ahora = Math.floor(Date.now() / 1000);

  let ids: string[] = [];
  try {
    ids = await listarMensajesNuevos(desde);
  } catch (error) {
    console.error("[revisarCorreoNuevo] Error listando mensajes:", error);
    return { correosRevisados: 0 };
  }

  console.log(`[revisarCorreoNuevo] ${ids.length} correo(s) nuevo(s) desde ${new Date(desde * 1000).toISOString()}`);

  if (ids.length === 0) {
    await guardarUltimoCheck(ahora);
    return { correosRevisados: 0 };
  }

  const informativos: string[] = [];

  for (const id of ids) {
    try {
      const correo = await obtenerResumenCorreo(id);

      // No crítico — nunca debe bloquear el procesamiento real del correo.
      registrarPersonaDesdeCorreo(correo.de, "correo_entrante").catch((error) =>
        console.error("[revisarCorreoNuevo] Error registrando remitente en el directorio de personas:", error)
      );

      // Chequeo directo por asunto ANTES de gastar una llamada a Claude —
      // más barato y más confiable que depender del clasificador para este
      // caso específico (ver nota en pareceAsuntoDeNotasReunion).
      if (pareceAsuntoDeNotasReunion(correo.asunto)) {
        await capturarNotasDeReunion(chatId, correo);
        continue;
      }

      const analisis = await analizarCorreo(correo);

      if (analisis.tipo === "documento_para_archivar" && correo.adjuntos.length > 0) {
        for (const adjunto of correo.adjuntos) {
          try {
            const bytes = await descargarAdjunto(correo.id, adjunto.attachmentId);
            await mkdir(UPLOADS_DIR, { recursive: true });

            const nombreArchivo = `${Date.now()}_${sanitizarNombre(adjunto.filename)}`;
            const destino = join(UPLOADS_DIR, nombreArchivo);
            await writeFile(destino, bytes);

            // Igual que en Telegram: antes de archivar en Drive, se lee el
            // contenido real por si es una factura/gasto que debería ir a
            // Holded en vez de Drive.
            let esGasto = false;
            if (MIMES_LEGIBLES_COMO_FACTURA.includes(adjunto.mimeType)) {
              try {
                const datosFactura = await extraerDatosFactura(destino, adjunto.mimeType);
                if (datosFactura.esFacturaOGasto) {
                  esGasto = true;
                  await procesarGastoEntrante({
                    chatId,
                    rutaLocal: destino,
                    nombreArchivoOriginal: adjunto.filename,
                    mimeType: adjunto.mimeType,
                    datos: datosFactura,
                  });
                }
              } catch (error) {
                console.error(`[revisarCorreoNuevo] Error leyendo "${adjunto.filename}" como factura (sigue como documento normal):`, error);
              }
            }

            if (!esGasto) {
              await manejarClasificacion({
                chatId,
                rutaLocal: destino,
                nombreArchivoOriginal: adjunto.filename,
                mimeType: adjunto.mimeType,
                nombreParaClasificar: adjunto.filename,
                captionEfectivo: `Adjunto de correo. De: ${correo.de}. Asunto: ${correo.asunto}. ${correo.extracto}`,
              });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[revisarCorreoNuevo] Error procesando adjunto "${adjunto.filename}":`, message);
          }
        }
        continue;
      }

      if (analisis.tipo === "notas_reunion") {
        await capturarNotasDeReunion(chatId, correo);
        continue;
      }

      if (analisis.tipo === "necesita_respuesta" || analisis.tipo === "instruccion_jefe") {
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
        continue;
      }

      // informativo (o cualquier otro caso sin acción concreta)
      informativos.push(
        [`📧 *${correo.asunto || "(sin asunto)"}*`, `De: ${correo.de}`, analisis.resumen].join("\n")
      );
    } catch (error) {
      console.error(`[revisarCorreoNuevo] Error procesando mensaje ${id}:`, error);
    }
  }

  if (informativos.length > 0) {
    const texto = [`📬 ${informativos.length} correo(s) informativo(s), sin acción requerida:`, "", ...informativos].join(
      "\n\n"
    );
    await sendTelegramMessage(chatId, texto);
  }

  await guardarUltimoCheck(ahora);

  return { correosRevisados: ids.length };
}

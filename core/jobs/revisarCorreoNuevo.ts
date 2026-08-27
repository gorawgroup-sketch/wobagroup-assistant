import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listarMensajesNuevos, obtenerResumenCorreo, obtenerCuerpoCompletoCorreo, descargarAdjunto } from "../gmail/client";
import { obtenerUltimoCheck, guardarUltimoCheck } from "../gmail/lastCheckStore";
import { analizarCorreo } from "../gmail/classifyEmail";
import { sendTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";
import { manejarClasificacion } from "../documental/processClassification";
import { extraerDatosFactura } from "../documental/extractInvoiceData";
import { procesarGastoEntrante } from "../gastos/procesarGastoEntrante";
import { crearPropuestaAccionCorreo, actualizarMessageIdAccionCorreo } from "../gmail/emailActionStore";
import { iniciarSeleccionEmpresaCaptura } from "../knowledge/capturaEmpresaCallbackHandler";

const UPLOADS_DIR = join(process.cwd(), "tmp", "uploads");

const MIMES_LEGIBLES_COMO_FACTURA = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"];

function sanitizarNombre(nombre: string): string {
  return nombre.replace(/[^\w.\-]+/g, "_").slice(0, 150);
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
        try {
          const cuerpo = await obtenerCuerpoCompletoCorreo(correo.id);
          const contenido = [`De: ${correo.de}`, `Asunto: ${correo.asunto}`, `Fecha: ${correo.fecha}`, "", cuerpo].join(
            "\n"
          );
          // Mismo flujo gateado con botones que CAPTURA normal (nunca se
          // guarda hasta que alguien confirme la empresa) — ver
          // core/knowledge/capturaEmpresaCallbackHandler.ts. Así las notas
          // de reunión quedan en la misma base de conocimiento que usa
          // consultar_base_conocimiento, no se pierden en el resumen
          // informativo de correos que no requieren acción.
          await iniciarSeleccionEmpresaCaptura(chatId, contenido, `notas de reunión (${correo.de})`);
        } catch (error) {
          console.error(`[revisarCorreoNuevo] Error capturando notas de reunión del correo ${id}:`, error);
          await sendTelegramMessage(
            chatId,
            `⚠️ Llegaron notas de reunión ("${correo.asunto}") pero hubo un error leyéndolas — revísalo manualmente en el correo.`
          );
        }
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

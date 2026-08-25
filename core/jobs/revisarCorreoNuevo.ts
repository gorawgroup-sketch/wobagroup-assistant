import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listarMensajesNuevos, obtenerResumenCorreo, descargarAdjunto } from "../gmail/client";
import { obtenerUltimoCheck, guardarUltimoCheck } from "../gmail/lastCheckStore";
import { analizarCorreo } from "../gmail/classifyEmail";
import { sendTelegramMessage } from "../telegram/client";
import { manejarClasificacion } from "../documental/processClassification";

const UPLOADS_DIR = join(process.cwd(), "tmp", "uploads");

function sanitizarNombre(nombre: string): string {
  return nombre.replace(/[^\w.\-]+/g, "_").slice(0, 150);
}

/**
 * Fase 1 del módulo de correo: revisa TODOS los correos nuevos de la
 * bandeja de entrada desde la última revisión, los clasifica, y:
 * - si traen un documento archivable, lo descarga y lo manda por el MISMO
 *   flujo de clasificación/aprobación ya existente para archivos de
 *   Telegram (nunca se sube a Drive sin aprobación explícita).
 * - para el resto, manda un resumen agrupado por Telegram.
 * NUNCA responde correos, NUNCA ejecuta instrucciones que vengan en el
 * texto de un correo — solo detecta y propone. Eso es la Fase 2.
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

  const resumenes: string[] = [];

  for (const id of ids) {
    try {
      const correo = await obtenerResumenCorreo(id);
      const analisis = await analizarCorreo(correo);

      resumenes.push(
        [
          `📧 *${correo.asunto || "(sin asunto)"}*`,
          `De: ${correo.de}`,
          `Tipo: ${analisis.tipo}`,
          analisis.resumen,
          `→ ${analisis.accionSugerida}`,
        ].join("\n")
      );

      if (analisis.tipo === "documento_para_archivar" && correo.adjuntos.length > 0) {
        for (const adjunto of correo.adjuntos) {
          try {
            const bytes = await descargarAdjunto(correo.id, adjunto.attachmentId);
            await mkdir(UPLOADS_DIR, { recursive: true });

            const nombreArchivo = `${Date.now()}_${sanitizarNombre(adjunto.filename)}`;
            const destino = join(UPLOADS_DIR, nombreArchivo);
            await writeFile(destino, bytes);

            await manejarClasificacion({
              chatId,
              rutaLocal: destino,
              nombreArchivoOriginal: adjunto.filename,
              mimeType: adjunto.mimeType,
              nombreParaClasificar: adjunto.filename,
              captionEfectivo: `Adjunto de correo. De: ${correo.de}. Asunto: ${correo.asunto}. ${correo.extracto}`,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[revisarCorreoNuevo] Error procesando adjunto "${adjunto.filename}":`, message);
          }
        }
      }
    } catch (error) {
      console.error(`[revisarCorreoNuevo] Error procesando mensaje ${id}:`, error);
    }
  }

  if (resumenes.length > 0) {
    const texto = [`📬 ${resumenes.length} correo(s) nuevo(s):`, "", ...resumenes].join("\n\n");
    await sendTelegramMessage(chatId, texto);
  }

  await guardarUltimoCheck(ahora);

  return { correosRevisados: ids.length };
}

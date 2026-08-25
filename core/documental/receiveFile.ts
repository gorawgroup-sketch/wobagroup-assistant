import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { downloadTelegramFile, getTelegramFile, sendTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";
import { clasificarDocumento } from "./classifyFile";
import { crearPropuestaClasificacion } from "./classificationStore";
import type { TelegramMessage } from "../telegram/types";

const UPLOADS_DIR = join(process.cwd(), "tmp", "uploads");

const FRIENDLY_TYPES: Record<string, string> = {
  "application/pdf": "PDF",
  "image/jpeg": "Imagen JPEG",
  "image/png": "Imagen PNG",
  "image/webp": "Imagen WEBP",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word (.docx)",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel (.xlsx)",
  "application/msword": "Word (.doc)",
  "application/vnd.ms-excel": "Excel (.xls)",
};

function tipoAmigable(mimeType: string | undefined): string {
  if (!mimeType) return "Archivo";
  return FRIENDLY_TYPES[mimeType] ?? mimeType;
}

function formatTamano(bytes: number | undefined): string {
  if (bytes === undefined) return "(tamaño desconocido)";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function sanitizarNombre(nombre: string): string {
  return nombre.replace(/[^\w.\-]+/g, "_").slice(0, 150);
}

function extensionDesdeMime(mimeType: string | undefined): string {
  if (!mimeType) return "";
  const partes = mimeType.split("/");
  return partes.length === 2 ? `.${partes[1].split("+")[0]}` : "";
}

interface ArchivoEntrante {
  fileId: string;
  nombreOriginal?: string;
  mimeType?: string;
  tamanoReportado?: number;
}

/**
 * Extrae el archivo adjunto de un mensaje de Telegram (documento o foto),
 * si lo trae. Para fotos, usa la resolución más grande (último elemento).
 */
function extraerArchivo(message: TelegramMessage): ArchivoEntrante | null {
  if (message.document) {
    return {
      fileId: message.document.file_id,
      nombreOriginal: message.document.file_name,
      mimeType: message.document.mime_type,
      tamanoReportado: message.document.file_size,
    };
  }

  if (message.photo && message.photo.length > 0) {
    const masGrande = message.photo[message.photo.length - 1];
    return {
      fileId: masGrande.file_id,
      mimeType: "image/jpeg",
      tamanoReportado: masGrande.file_size,
    };
  }

  return null;
}

/**
 * Recibe un archivo adjunto de Telegram (documento o foto), lo descarga a
 * una carpeta temporal local (tmp/uploads/), confirma por Telegram qué se
 * recibió, y propone una clasificación (empresa/tipo/carpeta) usando el
 * nombre del archivo y el caption — sin leer el contenido todavía. NO sube
 * nada a Drive — eso es el Paso 3.
 */
export async function handleIncomingFile(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const archivo = extraerArchivo(message);

  if (!archivo) return;

  try {
    const fileInfo = await getTelegramFile(archivo.fileId);

    if (!fileInfo.file_path) {
      await sendTelegramMessage(chatId, "Recibí un archivo pero Telegram no me dio una ruta de descarga válida.");
      return;
    }

    const bytes = await downloadTelegramFile(fileInfo.file_path);

    await mkdir(UPLOADS_DIR, { recursive: true });

    const extension = archivo.nombreOriginal
      ? ""
      : extensionDesdeMime(archivo.mimeType) || `.${fileInfo.file_path.split(".").pop() ?? "bin"}`;
    const nombreBase = archivo.nombreOriginal ?? `foto_${archivo.fileId}${extension}`;
    const nombreArchivo = `${Date.now()}_${sanitizarNombre(nombreBase)}`;
    const destino = join(UPLOADS_DIR, nombreArchivo);

    await writeFile(destino, bytes);

    const partes = [
      `📎 Archivo recibido:`,
      `Nombre: ${archivo.nombreOriginal ?? "(sin nombre, foto de Telegram)"}`,
      `Tipo: ${tipoAmigable(archivo.mimeType)}`,
      `Tamaño: ${formatTamano(bytes.length)}`,
    ];

    if (message.caption) {
      partes.push(`Texto adjunto: ${message.caption}`);
    }

    partes.push(``, `Guardado temporalmente. Clasificando...`);

    await sendTelegramMessage(chatId, partes.join("\n"));

    const nombreParaClasificar = archivo.nombreOriginal ?? "(foto sin nombre de archivo)";
    const clasificacion = await clasificarDocumento(nombreParaClasificar, message.caption);

    if (clasificacion.confianza === "baja") {
      await sendTelegramMessage(
        chatId,
        clasificacion.preguntaSiAmbiguo ?? "¿A qué empresa y carpeta pertenece este documento?"
      );
      return;
    }

    const propuesta = crearPropuestaClasificacion({
      nombreArchivo: nombreParaClasificar,
      clasificacion,
      chatId,
      messageId: 0,
    });

    const textoPropuesta = [
      `Este documento parece ser de **${clasificacion.empresa}**, tipo **${clasificacion.tipoDocumento}**.`,
      `¿Lo archivo en "${clasificacion.carpetaSugerida}"?`,
      ``,
      `(${clasificacion.razon})`,
    ].join("\n");

    const messageId = await sendTelegramMessageWithButtons(chatId, textoPropuesta, [
      [
        { text: "✅ Sí, archivar aquí", callback_data: `doc_confirm:${propuesta.id}` },
        { text: "✏️ Elegir otra carpeta", callback_data: `doc_reroute:${propuesta.id}` },
      ],
    ]);

    propuesta.messageId = messageId;
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : String(error);
    console.error("[receiveFile] Error procesando archivo entrante:", errMessage);
    await sendTelegramMessage(chatId, `Hubo un error recibiendo el archivo: ${errMessage}`);
  }
}

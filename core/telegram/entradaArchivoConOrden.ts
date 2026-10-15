import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extraerArchivo, tipoAmigable } from "../documental/receiveFile";
import { pideAccionElPie, pieMerecePregunta, textoOrdenConAdjunto } from "../documental/instruccionEnPie";
import { transcribirParaCaptura } from "../documental/transcribeForCapture";
import { leerModoConocimiento } from "../knowledge/modoConocimientoStore";
import { pareceCsv } from "../soportes/recibirExtracto";
import { downloadTelegramFile, getTelegramFile, sendTelegramMessage } from "./client";
import type { TelegramUpdate } from "./types";

/**
 * Entrada de Telegram → texto del chat, hermana de voiceInput.ts: una nota de voz se transcribe y sigue como mensaje escrito; un archivo cuyo pie es una
 * ORDEN («considerando este cuadro envíale un correo a…», Carlos 2026-10-15) se lee y sigue como mensaje escrito con el contenido leído. Mismo remitente
 * ya autorizado, mismas herramientas, mismas aprobaciones con botón: aquí no se decide ni se ejecuta nada.
 *
 * Devuelve undefined cuando NO es una orden (o algo falla): el archivo sigue el flujo documental de siempre y no se pierde nada. Quedan fuera, como antes,
 * el modo /conocimiento activo (todo archivo es conocimiento) y los CSV (extractos de Revolut, flujo de soportes).
 */
interface Dependencias {
  modoConocimientoActivo: (chatId: number) => Promise<boolean>;
  pideAccion: typeof pideAccionElPie;
  descargar: (fileId: string) => Promise<Buffer>;
  leer: typeof transcribirParaCaptura;
  avisar: (chatId: number, texto: string) => Promise<unknown>;
}

const DEPENDENCIAS_REALES: Dependencias = {
  modoConocimientoActivo: async (chatId) => Boolean(await leerModoConocimiento(chatId)),
  pideAccion: pideAccionElPie,
  descargar: async (fileId) => {
    const info = await getTelegramFile(fileId);
    if (!info.file_path) throw new Error("Telegram no dio una ruta de descarga válida");
    return downloadTelegramFile(info.file_path);
  },
  leer: transcribirParaCaptura,
  avisar: sendTelegramMessage,
};

export async function prepararEntradaArchivoConOrden(update: TelegramUpdate, overrides: Partial<Dependencias> = {}): Promise<TelegramUpdate | undefined> {
  const mensaje = update.message;
  const archivo = mensaje ? extraerArchivo(mensaje) : null;
  const caption = mensaje?.caption;
  if (!mensaje || !archivo || !pieMerecePregunta(caption)) return undefined;
  if (pareceCsv(archivo.nombreOriginal, archivo.mimeType)) return undefined;
  const deps = { ...DEPENDENCIAS_REALES, ...overrides };
  const chatId = mensaje.chat.id;
  let carpeta: string | undefined;
  try {
    if (await deps.modoConocimientoActivo(chatId)) return undefined;
    if (!(await deps.pideAccion(caption))) return undefined;
    carpeta = await mkdtemp(join(tmpdir(), "wobi-orden-"));
    const ruta = join(carpeta, "adjunto");
    await writeFile(ruta, await deps.descargar(archivo.fileId));
    const contenido = (await deps.leer(ruta, archivo.mimeType, caption)).trim();
    if (!contenido) return undefined;
    await deps.avisar(chatId, "📎 Leí el archivo y entendí que me pides una acción con él, no archivarlo. La preparo ahora.");
    const { photo: _foto, document: _documento, caption: _pie, ...resto } = mensaje;
    const nombre = archivo.nombreOriginal ?? "foto de Telegram";
    return { ...update, message: { ...resto, text: textoOrdenConAdjunto(caption, { nombre, tipo: tipoAmigable(archivo.mimeType), contenido }) } };
  } catch (error) {
    // Nada de la URL de descarga (lleva el token del bot) en el log.
    console.error("[entradaArchivoConOrden] No se pudo tratar el pie como orden; el archivo sigue el flujo documental:", error instanceof Error ? error.name : "Error");
    return undefined;
  } finally {
    if (carpeta) await rm(carpeta, { recursive: true, force: true }).catch((error) => console.error("[entradaArchivoConOrden] No se pudo limpiar el temporal (no crítico):", error instanceof Error ? error.name : "Error"));
  }
}

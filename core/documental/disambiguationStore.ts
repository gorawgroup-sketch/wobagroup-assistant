import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface PendienteDesambiguacion {
  chatId: number;
  rutaLocal: string;
  nombreArchivoOriginal: string;
  mimeType?: string;
  nombreParaClasificar: string;
  captionOriginal?: string;
  preguntaFormulada: string;
  creadoEn: number;
}

const DATA_DIR = join(process.cwd(), "data");
const STORE_PATH = join(DATA_DIR, "pendientes_desambiguacion.json");

// Corta a propósito (30 min): se espera una respuesta casi inmediata a la
// pregunta de desambiguación, no días después.
const TTL_MS = 30 * 60 * 1000;

async function leerTodas(): Promise<PendienteDesambiguacion[]> {
  if (!existsSync(STORE_PATH)) return [];
  try {
    const raw = await readFile(STORE_PATH, "utf-8");
    return JSON.parse(raw) as PendienteDesambiguacion[];
  } catch {
    return [];
  }
}

async function guardarTodas(pendientes: PendienteDesambiguacion[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(pendientes, null, 2), "utf-8");
}

function purgarVencidas(pendientes: PendienteDesambiguacion[]): PendienteDesambiguacion[] {
  const ahora = Date.now();
  return pendientes.filter((p) => ahora - p.creadoEn <= TTL_MS);
}

/**
 * Guarda (reemplazando cualquier pendiente previo del mismo chat) la
 * pregunta de desambiguación que se le acaba de mandar al usuario, para
 * poder conectarla con su próxima respuesta de texto.
 */
export async function guardarPendienteDesambiguacion(datos: Omit<PendienteDesambiguacion, "creadoEn">): Promise<void> {
  const vigentes = purgarVencidas(await leerTodas()).filter((p) => p.chatId !== datos.chatId);
  vigentes.push({ ...datos, creadoEn: Date.now() });
  await guardarTodas(vigentes);
}

/**
 * Si hay una pregunta de desambiguación pendiente para este chat, la
 * devuelve y la elimina (se consume con la respuesta). undefined si no hay
 * ninguna o ya venció.
 */
export async function consumirPendienteDesambiguacion(chatId: number): Promise<PendienteDesambiguacion | undefined> {
  const vigentes = purgarVencidas(await leerTodas());
  const idx = vigentes.findIndex((p) => p.chatId === chatId);

  if (idx === -1) {
    await guardarTodas(vigentes);
    return undefined;
  }

  const [pendiente] = vigentes.splice(idx, 1);
  await guardarTodas(vigentes);
  return pendiente;
}

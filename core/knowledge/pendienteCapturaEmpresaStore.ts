import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type EmpresaCaptura = "WOBA" | "EWORKS" | "Footprint" | "General";

export interface PendienteCapturaEmpresa {
  chatId: number;
  messageId: number;
  texto: string;
  autor?: string;
  empresasSeleccionadas: EmpresaCaptura[];
  creadoEn: number;
}

const DATA_DIR = join(process.cwd(), "data");
const STORE_PATH = join(DATA_DIR, "pendientes_captura_empresa.json");

// Corta a propósito (30 min): se espera que la persona toque los botones casi
// de inmediato después de mandar el CAPTURA, no que vuelva días después.
const TTL_MS = 30 * 60 * 1000;

async function leerTodas(): Promise<PendienteCapturaEmpresa[]> {
  if (!existsSync(STORE_PATH)) return [];
  try {
    const raw = await readFile(STORE_PATH, "utf-8");
    return JSON.parse(raw) as PendienteCapturaEmpresa[];
  } catch {
    return [];
  }
}

async function guardarTodas(pendientes: PendienteCapturaEmpresa[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(pendientes, null, 2), "utf-8");
}

function purgarVencidas(pendientes: PendienteCapturaEmpresa[]): PendienteCapturaEmpresa[] {
  const ahora = Date.now();
  return pendientes.filter((p) => ahora - p.creadoEn <= TTL_MS);
}

/** Guarda (reemplazando cualquier pendiente previo del mismo chat) la selección en curso. */
export async function guardarPendienteCapturaEmpresa(
  datos: Omit<PendienteCapturaEmpresa, "creadoEn">
): Promise<void> {
  const vigentes = purgarVencidas(await leerTodas()).filter((p) => p.chatId !== datos.chatId);
  vigentes.push({ ...datos, creadoEn: Date.now() });
  await guardarTodas(vigentes);
}

/** Lee el pendiente del chat sin consumirlo (para toggles intermedios). undefined si no hay o venció. */
export async function obtenerPendienteCapturaEmpresa(chatId: number): Promise<PendienteCapturaEmpresa | undefined> {
  const vigentes = purgarVencidas(await leerTodas());
  await guardarTodas(vigentes);
  return vigentes.find((p) => p.chatId === chatId);
}

/** Elimina el pendiente del chat (al confirmar o cancelar) sin devolverlo. */
export async function eliminarPendienteCapturaEmpresa(chatId: number): Promise<void> {
  const vigentes = purgarVencidas(await leerTodas()).filter((p) => p.chatId !== chatId);
  await guardarTodas(vigentes);
}

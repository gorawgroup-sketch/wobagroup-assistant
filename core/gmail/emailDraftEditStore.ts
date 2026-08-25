import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface PendienteEdicionBorrador {
  chatId: number;
  borradorId: string;
  creadoEn: number;
}

const DATA_DIR = join(process.cwd(), "data");
const STORE_PATH = join(DATA_DIR, "pendientes_edicion_borrador.json");
const TTL_MS = 30 * 60 * 1000; // 30 min — se espera respuesta casi inmediata

async function leerTodas(): Promise<PendienteEdicionBorrador[]> {
  if (!existsSync(STORE_PATH)) return [];
  try {
    const raw = await readFile(STORE_PATH, "utf-8");
    return JSON.parse(raw) as PendienteEdicionBorrador[];
  } catch {
    return [];
  }
}

async function guardarTodas(pendientes: PendienteEdicionBorrador[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(pendientes, null, 2), "utf-8");
}

function purgarVencidas(pendientes: PendienteEdicionBorrador[]): PendienteEdicionBorrador[] {
  const ahora = Date.now();
  return pendientes.filter((p) => ahora - p.creadoEn <= TTL_MS);
}

export async function guardarPendienteEdicionBorrador(chatId: number, borradorId: string): Promise<void> {
  const vigentes = purgarVencidas(await leerTodas()).filter((p) => p.chatId !== chatId);
  vigentes.push({ chatId, borradorId, creadoEn: Date.now() });
  await guardarTodas(vigentes);
}

export async function consumirPendienteEdicionBorrador(
  chatId: number
): Promise<PendienteEdicionBorrador | undefined> {
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

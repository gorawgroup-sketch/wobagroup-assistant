import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface PendienteCorreccionGasto {
  chatId: number;
  propuestaId: string;
  creadoEn: number;
}

const DATA_DIR = join(process.cwd(), "data");
const STORE_PATH = join(DATA_DIR, "pendientes_correccion_gasto.json");
const TTL_MS = 30 * 60 * 1000; // 30 min — se espera respuesta casi inmediata, igual que otros "pendiente_*"

async function leerTodas(): Promise<PendienteCorreccionGasto[]> {
  if (!existsSync(STORE_PATH)) return [];
  try {
    const raw = await readFile(STORE_PATH, "utf-8");
    return JSON.parse(raw) as PendienteCorreccionGasto[];
  } catch {
    return [];
  }
}

async function guardarTodas(pendientes: PendienteCorreccionGasto[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(pendientes, null, 2), "utf-8");
}

function purgarVencidas(pendientes: PendienteCorreccionGasto[]): PendienteCorreccionGasto[] {
  const ahora = Date.now();
  return pendientes.filter((p) => ahora - p.creadoEn <= TTL_MS);
}

export async function guardarPendienteCorreccionGasto(chatId: number, propuestaId: string): Promise<void> {
  const vigentes = purgarVencidas(await leerTodas()).filter((p) => p.chatId !== chatId);
  vigentes.push({ chatId, propuestaId, creadoEn: Date.now() });
  await guardarTodas(vigentes);
}

export async function consumirPendienteCorreccionGasto(chatId: number): Promise<PendienteCorreccionGasto | undefined> {
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

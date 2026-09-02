import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Espejo de emailOrientationStore.ts, para el mismo flujo aplicado a anotaciones del cashflow. */
export interface PendienteOrientacionAnotacion {
  chatId: number;
  messageId: number;
  ubicacion: string;
  detalle: string;
  recomendacion: string;
  creadoEn: number;
}

const DATA_DIR = join(process.cwd(), "data");
const STORE_PATH = join(DATA_DIR, "pendientes_orientacion_anotacion_cashflow.json");
const TTL_MS = 30 * 60 * 1000; // 30 min — se espera respuesta casi inmediata

async function leerTodas(): Promise<PendienteOrientacionAnotacion[]> {
  if (!existsSync(STORE_PATH)) return [];
  try {
    const raw = await readFile(STORE_PATH, "utf-8");
    return JSON.parse(raw) as PendienteOrientacionAnotacion[];
  } catch {
    return [];
  }
}

async function guardarTodas(pendientes: PendienteOrientacionAnotacion[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(pendientes, null, 2), "utf-8");
}

function purgarVencidas(pendientes: PendienteOrientacionAnotacion[]): PendienteOrientacionAnotacion[] {
  const ahora = Date.now();
  return pendientes.filter((p) => ahora - p.creadoEn <= TTL_MS);
}

export async function guardarPendienteOrientacionAnotacion(
  datos: Omit<PendienteOrientacionAnotacion, "creadoEn">
): Promise<void> {
  const vigentes = purgarVencidas(await leerTodas()).filter((p) => p.chatId !== datos.chatId);
  vigentes.push({ ...datos, creadoEn: Date.now() });
  await guardarTodas(vigentes);
}

export async function consumirPendienteOrientacionAnotacion(
  chatId: number
): Promise<PendienteOrientacionAnotacion | undefined> {
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

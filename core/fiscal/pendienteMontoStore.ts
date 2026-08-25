import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface PendienteMontoPago {
  chatId: number;
  messageId: number;
  entradaId: string;
  concepto: string;
  empresaCashflow: "WOBA" | "EWORKS";
  proveedor?: string;
  fechaVencimiento: string; // YYYY-MM-DD
  creadoEn: number;
}

const DATA_DIR = join(process.cwd(), "data");
const STORE_PATH = join(DATA_DIR, "pendientes_monto_pago.json");
const TTL_MS = 30 * 60 * 1000; // 30 min — se espera respuesta casi inmediata, igual que otros "pendiente_*"

async function leerTodas(): Promise<PendienteMontoPago[]> {
  if (!existsSync(STORE_PATH)) return [];
  try {
    const raw = await readFile(STORE_PATH, "utf-8");
    return JSON.parse(raw) as PendienteMontoPago[];
  } catch {
    return [];
  }
}

async function guardarTodas(pendientes: PendienteMontoPago[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(pendientes, null, 2), "utf-8");
}

function purgarVencidas(pendientes: PendienteMontoPago[]): PendienteMontoPago[] {
  const ahora = Date.now();
  return pendientes.filter((p) => ahora - p.creadoEn <= TTL_MS);
}

export async function guardarPendienteMontoPago(datos: Omit<PendienteMontoPago, "creadoEn">): Promise<void> {
  const vigentes = purgarVencidas(await leerTodas()).filter((p) => p.chatId !== datos.chatId);
  vigentes.push({ ...datos, creadoEn: Date.now() });
  await guardarTodas(vigentes);
}

export async function consumirPendienteMontoPago(chatId: number): Promise<PendienteMontoPago | undefined> {
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

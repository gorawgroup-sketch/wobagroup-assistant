import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Empresa } from "../holded/client";

export interface PropuestaReporteContable {
  id: string;
  chatId: number;
  messageId: number;
  empresa: Empresa;
  desde: string;
  hasta: string;
  correoDestino: string;
  creadoEn: number;
}

const DATA_DIR = join(process.cwd(), "data");
const STORE_PATH = join(DATA_DIR, "propuestas_reporte_contable.json");

// El archivo NUNCA se persiste aquí (solo los parámetros) — al aprobar, se
// regenera el Excel/PDF en el momento, así que no hace falta guardar
// binarios en ningún store. 60 min: da tiempo de sobra a que alguien vea la
// notificación y confirme, sin quedar viva indefinidamente.
const TTL_MS = 60 * 60 * 1000;

async function leerTodas(): Promise<PropuestaReporteContable[]> {
  if (!existsSync(STORE_PATH)) return [];
  try {
    const raw = await readFile(STORE_PATH, "utf-8");
    return JSON.parse(raw) as PropuestaReporteContable[];
  } catch {
    return [];
  }
}

async function guardarTodas(propuestas: PropuestaReporteContable[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(propuestas, null, 2), "utf-8");
}

function purgarVencidas(propuestas: PropuestaReporteContable[]): PropuestaReporteContable[] {
  const ahora = Date.now();
  return propuestas.filter((p) => ahora - p.creadoEn <= TTL_MS);
}

export async function crearPropuestaReporteContable(
  datos: Omit<PropuestaReporteContable, "id" | "creadoEn">
): Promise<PropuestaReporteContable> {
  const vigentes = purgarVencidas(await leerTodas());
  const propuesta: PropuestaReporteContable = { ...datos, id: randomUUID(), creadoEn: Date.now() };
  vigentes.push(propuesta);
  await guardarTodas(vigentes);
  return propuesta;
}

export async function actualizarMessageIdReporteContable(id: string, messageId: number): Promise<void> {
  const vigentes = purgarVencidas(await leerTodas());
  const idx = vigentes.findIndex((p) => p.id === id);
  if (idx !== -1) {
    vigentes[idx].messageId = messageId;
    await guardarTodas(vigentes);
  }
}

/** Consume (lee y elimina) una propuesta por id. undefined si no existe o venció. */
export async function consumirPropuestaReporteContable(id: string): Promise<PropuestaReporteContable | undefined> {
  const vigentes = purgarVencidas(await leerTodas());
  const idx = vigentes.findIndex((p) => p.id === id);
  if (idx === -1) {
    await guardarTodas(vigentes);
    return undefined;
  }
  const [propuesta] = vigentes.splice(idx, 1);
  await guardarTodas(vigentes);
  return propuesta;
}

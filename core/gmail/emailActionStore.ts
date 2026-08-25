import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TipoCorreo } from "./classifyEmail";

export interface PropuestaAccionCorreo {
  id: string;
  chatId: number;
  messageId: number;
  de: string;
  asunto: string;
  tipo: TipoCorreo;
  resumen: string;
  accionSugerida: string;
  threadId: string;
  messageIdHeader: string;
  creadoEn: number;
}

const DATA_DIR = join(process.cwd(), "data");
const STORE_PATH = join(DATA_DIR, "propuestas_correo.json");
const TTL_MS = 48 * 60 * 60 * 1000; // 48 horas

async function leerTodas(): Promise<PropuestaAccionCorreo[]> {
  if (!existsSync(STORE_PATH)) return [];
  try {
    const raw = await readFile(STORE_PATH, "utf-8");
    return JSON.parse(raw) as PropuestaAccionCorreo[];
  } catch {
    return [];
  }
}

async function guardarTodas(propuestas: PropuestaAccionCorreo[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(propuestas, null, 2), "utf-8");
}

function purgarVencidas(propuestas: PropuestaAccionCorreo[]): PropuestaAccionCorreo[] {
  const ahora = Date.now();
  return propuestas.filter((p) => ahora - p.creadoEn <= TTL_MS);
}

export async function crearPropuestaAccionCorreo(
  datos: Omit<PropuestaAccionCorreo, "id" | "creadoEn">
): Promise<PropuestaAccionCorreo> {
  const vigentes = purgarVencidas(await leerTodas());
  const propuesta: PropuestaAccionCorreo = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };
  vigentes.push(propuesta);
  await guardarTodas(vigentes);
  return propuesta;
}

export async function actualizarMessageIdAccionCorreo(id: string, messageId: number): Promise<void> {
  const todas = await leerTodas();
  const idx = todas.findIndex((p) => p.id === id);
  if (idx === -1) return;
  todas[idx].messageId = messageId;
  await guardarTodas(todas);
}

export async function obtenerPropuestaAccionCorreo(id: string): Promise<PropuestaAccionCorreo | undefined> {
  const vigentes = purgarVencidas(await leerTodas());
  return vigentes.find((p) => p.id === id);
}

/** Devuelve la propuesta y la elimina (se llama al descartar o proceder). */
export async function consumirPropuestaAccionCorreo(id: string): Promise<PropuestaAccionCorreo | undefined> {
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

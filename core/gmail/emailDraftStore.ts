import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface BorradorCorreo {
  id: string;
  chatId: number;
  messageId: number;
  to: string;
  subject: string;
  threadId?: string;
  messageIdHeader?: string;
  cuerpo: string;
  creadoEn: number;
}

const DATA_DIR = join(process.cwd(), "data");
const STORE_PATH = join(DATA_DIR, "borradores_correo.json");
const TTL_MS = 48 * 60 * 60 * 1000; // 48 horas

async function leerTodos(): Promise<BorradorCorreo[]> {
  if (!existsSync(STORE_PATH)) return [];
  try {
    const raw = await readFile(STORE_PATH, "utf-8");
    return JSON.parse(raw) as BorradorCorreo[];
  } catch {
    return [];
  }
}

async function guardarTodos(borradores: BorradorCorreo[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(borradores, null, 2), "utf-8");
}

function purgarVencidos(borradores: BorradorCorreo[]): BorradorCorreo[] {
  const ahora = Date.now();
  return borradores.filter((b) => ahora - b.creadoEn <= TTL_MS);
}

export async function crearBorradorCorreo(
  datos: Omit<BorradorCorreo, "id" | "creadoEn">
): Promise<BorradorCorreo> {
  const vigentes = purgarVencidos(await leerTodos());
  const borrador: BorradorCorreo = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };
  vigentes.push(borrador);
  await guardarTodos(vigentes);
  return borrador;
}

export async function actualizarMessageIdBorrador(id: string, messageId: number): Promise<void> {
  const todos = await leerTodos();
  const idx = todos.findIndex((b) => b.id === id);
  if (idx === -1) return;
  todos[idx].messageId = messageId;
  await guardarTodos(todos);
}

export async function actualizarCuerpoBorrador(id: string, cuerpo: string): Promise<BorradorCorreo | undefined> {
  const todos = await leerTodos();
  const idx = todos.findIndex((b) => b.id === id);
  if (idx === -1) return undefined;
  todos[idx].cuerpo = cuerpo;
  await guardarTodos(todos);
  return todos[idx];
}

/**
 * Cuenta los borradores pendientes de aprobación (solo lectura, para
 * diagnóstico/dashboard). Nota: este store vive en disco local (data/), que
 * no sobrevive un redeploy de Railway — el conteo solo refleja lo que este
 * proceso conoce desde su último arranque, no necesariamente todo lo que se
 * propuso antes de un deploy.
 */
export async function contarBorradoresPendientes(): Promise<number> {
  const vigentes = purgarVencidos(await leerTodos());
  return vigentes.length;
}

export async function obtenerBorradorCorreo(id: string): Promise<BorradorCorreo | undefined> {
  const vigentes = purgarVencidos(await leerTodos());
  return vigentes.find((b) => b.id === id);
}

/** Devuelve el borrador y lo elimina (se llama al enviar o cancelar). */
export async function consumirBorradorCorreo(id: string): Promise<BorradorCorreo | undefined> {
  const vigentes = purgarVencidos(await leerTodos());
  const idx = vigentes.findIndex((b) => b.id === id);
  if (idx === -1) {
    await guardarTodos(vigentes);
    return undefined;
  }
  const [borrador] = vigentes.splice(idx, 1);
  await guardarTodos(vigentes);
  return borrador;
}

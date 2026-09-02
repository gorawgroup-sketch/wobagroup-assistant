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

/**
 * Guarda (reemplazando cualquier pendiente previo del MISMO mensaje —
 * chatId+messageId, no todo el chat) la selección en curso.
 *
 * Antes esto reemplazaba por chatId solo, así que dos capturas pendientes a
 * la vez en el mismo chat se pisaban entre sí — la segunda borraba en
 * silencio el "texto" de la primera aunque sus botones siguieran visibles
 * en Telegram, y confirmar la primera terminaba guardando el contenido de
 * la segunda. Con un solo trigger manual de CAPTURA esto casi nunca pasaba
 * en la práctica; con la evaluación automática de correos informativos
 * (ver revisarCorreoNuevo.ts) es realista que caigan 2+ en la misma
 * revisión horaria, así que ahora cada mensaje con botones tiene su propio
 * pendiente independiente.
 */
export async function guardarPendienteCapturaEmpresa(
  datos: Omit<PendienteCapturaEmpresa, "creadoEn">
): Promise<void> {
  const vigentes = purgarVencidas(await leerTodas()).filter(
    (p) => !(p.chatId === datos.chatId && p.messageId === datos.messageId)
  );
  vigentes.push({ ...datos, creadoEn: Date.now() });
  await guardarTodas(vigentes);
}

/** Lee el pendiente de ESE mensaje sin consumirlo (para toggles intermedios). undefined si no hay o venció. */
export async function obtenerPendienteCapturaEmpresa(
  chatId: number,
  messageId: number
): Promise<PendienteCapturaEmpresa | undefined> {
  const vigentes = purgarVencidas(await leerTodas());
  await guardarTodas(vigentes);
  return vigentes.find((p) => p.chatId === chatId && p.messageId === messageId);
}

/** Todos los pendientes vigentes de un chat (puede haber más de uno) — para el aviso de "te quedó algo sin confirmar". */
export async function obtenerPendientesCapturaEmpresaPorChat(chatId: number): Promise<PendienteCapturaEmpresa[]> {
  const vigentes = purgarVencidas(await leerTodas());
  await guardarTodas(vigentes);
  return vigentes.filter((p) => p.chatId === chatId);
}

/** Elimina el pendiente de ESE mensaje (al confirmar o cancelar) sin devolverlo. */
export async function eliminarPendienteCapturaEmpresa(chatId: number, messageId: number): Promise<void> {
  const vigentes = purgarVencidas(await leerTodas()).filter(
    (p) => !(p.chatId === chatId && p.messageId === messageId)
  );
  await guardarTodas(vigentes);
}

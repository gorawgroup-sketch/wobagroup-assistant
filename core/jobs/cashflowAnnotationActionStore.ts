import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Pedido explícito de Carlos: cuando revisarAnotacionesCashflow.ts le manda
 * una recomendación sobre una anotación del cashflow, antes no había ninguna
 * forma de actuar sobre eso — solo texto plano, sin botones. Este store
 * (y cashflowAnnotationCallbackHandler.ts) le agregan el mismo patrón de
 * "✅ Hazlo tú / ✏️ Dar instrucciones / ℹ️ Dejar como informativo" que ya
 * existía para correos que necesitan acción (ver emailActionStore.ts, del
 * que este archivo es un espejo deliberado — misma forma, mismo TTL).
 */
export interface PropuestaAccionAnotacion {
  id: string;
  chatId: number;
  messageId: number;
  ubicacion: string;
  detalle: string;
  recomendacion: string;
  creadoEn: number;
}

const DATA_DIR = join(process.cwd(), "data");
const STORE_PATH = join(DATA_DIR, "propuestas_anotacion_cashflow.json");
const TTL_MS = 48 * 60 * 60 * 1000; // 48 horas — mismo criterio que emailActionStore

async function leerTodas(): Promise<PropuestaAccionAnotacion[]> {
  if (!existsSync(STORE_PATH)) return [];
  try {
    const raw = await readFile(STORE_PATH, "utf-8");
    return JSON.parse(raw) as PropuestaAccionAnotacion[];
  } catch {
    return [];
  }
}

async function guardarTodas(propuestas: PropuestaAccionAnotacion[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(propuestas, null, 2), "utf-8");
}

function purgarVencidas(propuestas: PropuestaAccionAnotacion[]): PropuestaAccionAnotacion[] {
  const ahora = Date.now();
  return propuestas.filter((p) => ahora - p.creadoEn <= TTL_MS);
}

export async function crearPropuestaAccionAnotacion(
  datos: Omit<PropuestaAccionAnotacion, "id" | "creadoEn">
): Promise<PropuestaAccionAnotacion> {
  const vigentes = purgarVencidas(await leerTodas());
  const propuesta: PropuestaAccionAnotacion = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };
  vigentes.push(propuesta);
  await guardarTodas(vigentes);
  return propuesta;
}

export async function actualizarMessageIdAccionAnotacion(id: string, messageId: number): Promise<void> {
  const todas = await leerTodas();
  const idx = todas.findIndex((p) => p.id === id);
  if (idx === -1) return;
  todas[idx].messageId = messageId;
  await guardarTodas(todas);
}

/** Devuelve la propuesta y la elimina (se llama al descartar o proceder). */
export async function consumirPropuestaAccionAnotacion(id: string): Promise<PropuestaAccionAnotacion | undefined> {
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

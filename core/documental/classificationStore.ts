import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ClasificacionDocumento } from "./classifyFile";

export interface PropuestaClasificacion {
  id: string;
  nombreArchivoOriginal: string;
  /** Ruta local donde quedó guardado el archivo (tmp/uploads/...). */
  rutaLocal: string;
  mimeType?: string;
  clasificacion: ClasificacionDocumento;
  chatId: number;
  messageId: number;
  creadoEn: number;
}

const DATA_DIR = join(process.cwd(), "data");
const STORE_PATH = join(DATA_DIR, "propuestas_documentos.json");

// NOTA: esto sobrevive reinicios del proceso (crash, OOM) dentro del mismo
// contenedor/deployment, pero NO sobrevive un redeploy real (Railway levanta
// un contenedor nuevo con filesystem limpio). Para eso haría falta almacenar
// en algo externo, como se hizo con las propuestas de cashflow en el Sheet.
const TTL_MS = 48 * 60 * 60 * 1000; // 48 horas

async function leerTodas(): Promise<PropuestaClasificacion[]> {
  if (!existsSync(STORE_PATH)) return [];

  try {
    const raw = await readFile(STORE_PATH, "utf-8");
    return JSON.parse(raw) as PropuestaClasificacion[];
  } catch {
    return [];
  }
}

async function guardarTodas(propuestas: PropuestaClasificacion[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(propuestas, null, 2), "utf-8");
}

function purgarVencidas(propuestas: PropuestaClasificacion[]): PropuestaClasificacion[] {
  const ahora = Date.now();
  return propuestas.filter((p) => ahora - p.creadoEn <= TTL_MS);
}

export async function crearPropuestaClasificacion(
  datos: Omit<PropuestaClasificacion, "id" | "creadoEn">
): Promise<PropuestaClasificacion> {
  const vigentes = purgarVencidas(await leerTodas());

  const propuesta: PropuestaClasificacion = {
    ...datos,
    id: randomUUID().slice(0, 8),
    creadoEn: Date.now(),
  };

  vigentes.push(propuesta);
  await guardarTodas(vigentes);
  return propuesta;
}

/** Actualiza el message_id real de Telegram tras enviar el mensaje con botones. */
export async function actualizarMessageIdClasificacion(id: string, messageId: number): Promise<void> {
  const todas = await leerTodas();
  const idx = todas.findIndex((p) => p.id === id);
  if (idx === -1) return;

  todas[idx].messageId = messageId;
  await guardarTodas(todas);
}

/**
 * Devuelve la propuesta y la elimina del archivo (aprobada o redirigida, ya
 * no debe quedar pendiente). También purga cualquier propuesta vencida.
 */
export async function consumirPropuestaClasificacion(id: string): Promise<PropuestaClasificacion | undefined> {
  const vigentes = purgarVencidas(await leerTodas());
  const idx = vigentes.findIndex((p) => p.id === id);

  if (idx === -1) {
    await guardarTodas(vigentes); // persiste la purga aunque no se encuentre esta id
    return undefined;
  }

  const [propuesta] = vigentes.splice(idx, 1);
  await guardarTodas(vigentes);
  return propuesta;
}

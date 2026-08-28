import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PropuestaGasto } from "./gastoProposalSheet";

export interface AlternativaContacto {
  contactId: string;
  contactName: string;
  motivo: "nombre_parecido" | "mismo_importe";
  detalle?: string;
}

export interface ResolucionContactoPendiente {
  id: string;
  propuesta: PropuestaGasto;
  empresaFinal: PropuestaGasto["empresa"];
  conceptoFinal: string;
  alternativas: AlternativaContacto[];
  /** Mensaje que muestra los botones de alternativas — puede ser distinto de propuesta.messageId. */
  chatId: number;
  messageId: number;
  creadoEn: number;
}

const DATA_DIR = join(process.cwd(), "data");
const STORE_PATH = join(DATA_DIR, "resoluciones_contacto_gasto.json");
const TTL_MS = 30 * 60 * 1000; // 30 min, igual que pendienteCorreccionGastoStore

async function leerTodas(): Promise<ResolucionContactoPendiente[]> {
  if (!existsSync(STORE_PATH)) return [];
  try {
    const raw = await readFile(STORE_PATH, "utf-8");
    return JSON.parse(raw) as ResolucionContactoPendiente[];
  } catch {
    return [];
  }
}

async function guardarTodas(pendientes: ResolucionContactoPendiente[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(pendientes, null, 2), "utf-8");
}

function purgarVencidas(pendientes: ResolucionContactoPendiente[]): ResolucionContactoPendiente[] {
  const ahora = Date.now();
  return pendientes.filter((p) => ahora - p.creadoEn <= TTL_MS);
}

export async function guardarResolucionContacto(
  datos: Omit<ResolucionContactoPendiente, "id" | "creadoEn">
): Promise<ResolucionContactoPendiente> {
  const vigentes = purgarVencidas(await leerTodas());
  const resolucion: ResolucionContactoPendiente = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };
  vigentes.push(resolucion);
  await guardarTodas(vigentes);
  return resolucion;
}

export async function consumirResolucionContacto(id: string): Promise<ResolucionContactoPendiente | undefined> {
  const vigentes = purgarVencidas(await leerTodas());
  const idx = vigentes.findIndex((p) => p.id === id);
  if (idx === -1) {
    await guardarTodas(vigentes);
    return undefined;
  }
  const [pendiente] = vigentes.splice(idx, 1);
  await guardarTodas(vigentes);
  return pendiente;
}

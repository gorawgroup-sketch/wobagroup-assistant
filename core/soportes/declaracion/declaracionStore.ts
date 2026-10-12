import { randomUUID } from "node:crypto";
import { actualizarFila, agregarFila, leerFilas } from "../../google/sheetsKeyValueStore";

/**
 * Registro durable de cada declaración de gastos sin soporte: qué se generó, para quién, dónde está en Drive, con qué
 * borrador/hilo se envió y en qué estado va (generada → enviada → firmada → aplicada). Vive en Sheets, como el resto de
 * almacenes de la familia de soportes, para sobrevivir a despliegues y para que el seguimiento (recordatorio, detección de
 * la firma, aplicación como soporte en Holded) tenga una sola fuente de verdad.
 */
const TAB_NAME = "_declaraciones_sin_soporte";
const HEADERS = ["id", "empresa", "titular", "email", "cargoFirmante", "chatId", "cargosJson", "driveFileId", "driveUrl", "nombreArchivo",
  "borradorId", "threadId", "estado", "creadoEn", "enviadoEn", "firmadaEn", "archivoFirmadoDriveId", "nota", "firmaCandidataJson", "recordatorioEn"];
const NUM_COLS = HEADERS.length;

export type EstadoDeclaracion = "generada" | "enviada" | "firmada" | "aplicada" | "descartada";
export interface CargoDeclarado {
  id: string; fecha: string; lugar: string; valor: number; moneda: string;
  /** Paso C: cómo quedó el soporte en Holded para este cargo (adjuntado a una compra existente, o propuesto como gasto nuevo). */
  estadoSoporte?: "adjuntado" | "propuesto"; compraId?: string;
}
/** Adjunto recibido en el hilo de la declaración que podría ser el documento firmado (pendiente del botón de Carlos). */
export interface FirmaCandidata { mensajeId: string; filename: string; mimeType: string; size: number; recibidaEn: number }
export interface Declaracion {
  id: string; empresa: string; titular: string; email: string; cargoFirmante: string; chatId: number;
  cargos: CargoDeclarado[]; driveFileId: string; driveUrl: string; nombreArchivo: string;
  borradorId?: string; threadId?: string; estado: EstadoDeclaracion; creadoEn: number; enviadoEn?: number; firmadaEn?: number;
  archivoFirmadoDriveId?: string; nota?: string;
  firmaCandidata?: FirmaCandidata; recordatorioEn?: number;
}

const aFila = (d: Declaracion): (string | number)[] => [d.id, d.empresa, d.titular, d.email, d.cargoFirmante, d.chatId, JSON.stringify(d.cargos),
  d.driveFileId, d.driveUrl, d.nombreArchivo, d.borradorId ?? "", d.threadId ?? "", d.estado, d.creadoEn, d.enviadoEn ?? "", d.firmadaEn ?? "",
  d.archivoFirmadoDriveId ?? "", d.nota ?? "", d.firmaCandidata ? JSON.stringify(d.firmaCandidata) : "", d.recordatorioEn ?? ""];

function desdeFila(v: string[]): Declaracion | undefined {
  if (!v[0]) return undefined;
  let cargos: CargoDeclarado[] = [];
  try { cargos = JSON.parse(v[6] || "[]"); } catch { return undefined; }
  return { id: v[0], empresa: v[1], titular: v[2], email: v[3], cargoFirmante: v[4], chatId: Number(v[5]) || 0, cargos, driveFileId: v[7],
    driveUrl: v[8], nombreArchivo: v[9], borradorId: v[10] || undefined, threadId: v[11] || undefined, estado: (v[12] as EstadoDeclaracion) || "generada",
    creadoEn: Number(v[13]) || 0, enviadoEn: Number(v[14]) || undefined, firmadaEn: Number(v[15]) || undefined,
    archivoFirmadoDriveId: v[16] || undefined, nota: v[17] || undefined,
    firmaCandidata: firmaDesdeCelda(v[18]), recordatorioEn: Number(v[19]) || undefined };
}

function firmaDesdeCelda(celda: string | undefined): FirmaCandidata | undefined {
  if (!celda) return undefined;
  try { return JSON.parse(celda) as FirmaCandidata; } catch { return undefined; }
}

export async function crearDeclaracion(d: Omit<Declaracion, "id" | "creadoEn" | "estado"> & { estado?: EstadoDeclaracion }): Promise<Declaracion> {
  const nueva: Declaracion = { ...d, id: randomUUID().slice(0, 8), creadoEn: Date.now(), estado: d.estado ?? "generada" };
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, aFila(nueva));
  return nueva;
}

export async function listarDeclaraciones(filtro: { empresa?: string; email?: string; estados?: EstadoDeclaracion[] } = {}): Promise<Declaracion[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  return filas.map((f) => desdeFila(f.valores)).filter((d): d is Declaracion => Boolean(d))
    .filter((d) => (!filtro.empresa || d.empresa === filtro.empresa) && (!filtro.email || d.email.toLowerCase() === filtro.email.toLowerCase()) &&
      (!filtro.estados || filtro.estados.includes(d.estado)));
}

export async function obtenerDeclaracion(id: string): Promise<Declaracion | undefined> {
  return (await listarDeclaraciones()).find((d) => d.id === id);
}

export async function actualizarDeclaracion(id: string, cambios: Partial<Omit<Declaracion, "id" | "creadoEn">>): Promise<Declaracion | undefined> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const fila = filas.find((f) => f.valores[0] === id);
  if (!fila) return undefined;
  const actual = desdeFila(fila.valores);
  if (!actual) return undefined;
  const nueva = { ...actual, ...cambios };
  await actualizarFila(TAB_NAME, fila.rowIndex, NUM_COLS, aFila(nueva));
  return nueva;
}

/** Declaración ligada a un borrador de correo (para marcarla «enviada» cuando el borrador se envía). */
export async function declaracionDeBorrador(borradorId: string): Promise<Declaracion | undefined> {
  return (await listarDeclaraciones()).find((d) => d.borradorId === borradorId);
}

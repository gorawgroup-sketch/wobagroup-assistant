import { actualizarFila, agregarFila, eliminarFilas, leerFilas } from "../google/sheetsKeyValueStore";
import { conMutex } from "../utils/asyncMutex";
import type { CargoCorreo } from "./redactarCorreoSoportes";

/**
 * Estado durable de una campaña de soportes mientras Carlos decide: un mensaje resumen con una casilla por persona.
 * Una fila por persona; todas comparten campaña, chat y mensaje. Vive en Sheets (no en memoria ni en disco): sobrevive
 * a un despliegue entre que se muestra el resumen y se pulsa el botón.
 */
const TAB_NAME = "_campanas_soportes";
const HEADERS = [
  "campana", "indice", "chatId", "messageId", "empresa", "desde", "hasta", "titular", "email", "fuenteEmail",
  "seleccionado", "estado", "yaSolicitados", "creadoEn", "cargosJson", "nota",
];
const NUM_COLS = HEADERS.length;
const TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_CARACTERES_CELDA = 45_000;
export const mutexCampana = (id: string): string => `soportes-campana:${id}`;

export type EstadoPersona = "pendiente" | "enviando" | "enviado" | "fallido" | "omitido";

export interface PersonaCampana {
  rowIndex: number;
  campana: string;
  indice: number;
  chatId: number;
  messageId: number;
  empresa: string;
  desde: string;
  hasta: string;
  titular: string;
  email: string;
  fuenteEmail: "confirmado" | "directorio" | "";
  seleccionado: boolean;
  estado: EstadoPersona;
  yaSolicitados: number;
  creadoEn: number;
  cargos: CargoCorreo[];
  /** Recuento del análisis (solo en la primera persona): se vuelve a mostrar en cada actualización del resumen. */
  nota: string;
}

function aFila(p: Omit<PersonaCampana, "rowIndex">): (string | number)[] {
  const cargosJson = JSON.stringify(p.cargos);
  if (cargosJson.length > MAX_CARACTERES_CELDA) {
    throw new Error(`${p.titular} tiene demasiados cargos (${p.cargos.length}) para guardarlos en una campaña.`);
  }
  return [p.campana, p.indice, p.chatId, p.messageId, p.empresa, p.desde, p.hasta, p.titular, p.email, p.fuenteEmail,
    p.seleccionado ? "true" : "false", p.estado, p.yaSolicitados, p.creadoEn, cargosJson, p.nota];
}

function desdeFila(rowIndex: number, v: string[]): PersonaCampana | undefined {
  let cargos: CargoCorreo[];
  try { cargos = JSON.parse(v[14]); } catch (error) {
    console.error("[soportes] Fila de campaña ilegible, se ignora:", error instanceof Error ? error.message : error);
    return undefined;
  }
  return {
    rowIndex, campana: v[0], indice: Number(v[1]), chatId: Number(v[2]), messageId: Number(v[3]), empresa: v[4], desde: v[5], hasta: v[6],
    titular: v[7], email: v[8], fuenteEmail: v[9] as PersonaCampana["fuenteEmail"], seleccionado: v[10] === "true",
    estado: v[11] as EstadoPersona, yaSolicitados: Number(v[12]) || 0, creadoEn: Number(v[13]) || 0, cargos, nota: v[15] ?? "",
  };
}

export async function leerCampana(id: string): Promise<PersonaCampana[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  return filas.filter((f) => f.valores[0] === id).map((f) => desdeFila(f.rowIndex, f.valores)).filter((p): p is PersonaCampana => !!p)
    .sort((a, b) => a.indice - b.indice);
}

export async function crearCampana(personas: Array<Omit<PersonaCampana, "rowIndex">>): Promise<void> {
  await conMutex(mutexCampana(personas[0]?.campana ?? "nueva"), async () => {
    for (const p of personas) await agregarFila(TAB_NAME, NUM_COLS, HEADERS, aFila(p));
  });
  void purgarCaducadas();
}

/** Actualiza campos de una persona; el llamador debe sostener `mutexCampana`. */
export async function actualizarPersona(p: PersonaCampana, cambios: Partial<Omit<PersonaCampana, "rowIndex" | "campana" | "indice">>): Promise<PersonaCampana> {
  const siguiente = { ...p, ...cambios };
  const { rowIndex: _ignorado, ...resto } = siguiente;
  await actualizarFila(TAB_NAME, p.rowIndex, NUM_COLS, aFila(resto));
  return siguiente;
}

export async function fijarMensaje(id: string, messageId: number): Promise<void> {
  await conMutex(mutexCampana(id), async () => {
    for (const p of await leerCampana(id)) await actualizarPersona(p, { messageId });
  });
}

async function purgarCaducadas(): Promise<void> {
  try {
    const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
    const vencidas = filas.filter((f) => Date.now() - (Number(f.valores[13]) || 0) > TTL_MS).map((f) => f.rowIndex);
    if (vencidas.length) await eliminarFilas(TAB_NAME, vencidas, HEADERS);
  } catch (error) {
    console.error("[soportes] No se pudieron purgar campañas caducadas (no crítico):", error instanceof Error ? error.message : error);
  }
}

import { actualizarFila, agregarFila, eliminarFilas, leerFilas } from "../google/sheetsKeyValueStore";
import { conMutex } from "../utils/asyncMutex";

/**
 * Estado durable del aviso de formato mientras un superadministrador decide: una fila por destinatario, todas con el mismo id de aviso,
 * chat y mensaje. Vive en Sheets (sobrevive a un despliegue entre que se muestra el aviso y se pulsa «Enviar»).
 */
const TAB_NAME = "_soportes_avisos_formato";
const HEADERS = ["aviso", "indice", "chatId", "messageId", "titular", "email", "empresas", "estado", "creadoEn"];
const NUM_COLS = HEADERS.length;
const TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const mutexAviso = (id: string): string => `soportes-aviso-formato:${id}`;

export type EstadoDestinatario = "pendiente" | "enviando" | "enviado" | "fallido" | "omitido";

export interface DestinatarioGuardado {
  rowIndex: number; aviso: string; indice: number; chatId: number; messageId: number;
  titular: string; email: string; empresas: string[]; estado: EstadoDestinatario; creadoEn: number;
}

const aFila = (d: Omit<DestinatarioGuardado, "rowIndex">): (string | number)[] =>
  [d.aviso, d.indice, d.chatId, d.messageId, d.titular, d.email, JSON.stringify(d.empresas), d.estado, d.creadoEn];

function desdeFila(rowIndex: number, v: string[]): DestinatarioGuardado | undefined {
  let empresas: string[];
  try { empresas = JSON.parse(v[6]); } catch { return undefined; }
  if (!Array.isArray(empresas)) return undefined;
  return { rowIndex, aviso: v[0], indice: Number(v[1]), chatId: Number(v[2]), messageId: Number(v[3]), titular: v[4], email: v[5], empresas: empresas.map(String), estado: v[7] as EstadoDestinatario, creadoEn: Number(v[8]) || 0 };
}

export async function leerAviso(id: string): Promise<DestinatarioGuardado[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  return filas.filter((f) => f.valores[0] === id).map((f) => desdeFila(f.rowIndex, f.valores)).filter((d): d is DestinatarioGuardado => !!d).sort((a, b) => a.indice - b.indice);
}

export async function crearAviso(destinatarios: Array<Omit<DestinatarioGuardado, "rowIndex">>): Promise<void> {
  await conMutex(mutexAviso(destinatarios[0]?.aviso ?? "nuevo"), async () => {
    for (const d of destinatarios) await agregarFila(TAB_NAME, NUM_COLS, HEADERS, aFila(d));
  });
  void purgarCaducados();
}

/** El llamador debe sostener `mutexAviso`. */
export async function actualizarDestinatario(d: DestinatarioGuardado, cambios: Partial<Pick<DestinatarioGuardado, "estado" | "messageId">>): Promise<DestinatarioGuardado> {
  const siguiente = { ...d, ...cambios };
  const { rowIndex: _ignorado, ...resto } = siguiente;
  await actualizarFila(TAB_NAME, d.rowIndex, NUM_COLS, aFila(resto));
  return siguiente;
}

export async function fijarMensajeAviso(id: string, messageId: number): Promise<void> {
  await conMutex(mutexAviso(id), async () => { for (const d of await leerAviso(id)) await actualizarDestinatario(d, { messageId }); });
}

async function purgarCaducados(): Promise<void> {
  try {
    const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
    const vencidas = filas.filter((f) => Date.now() - (Number(f.valores[8]) || 0) > TTL_MS).map((f) => f.rowIndex);
    if (vencidas.length) await eliminarFilas(TAB_NAME, vencidas, HEADERS);
  } catch (error) {
    console.error("[soportes] No se pudieron purgar avisos de formato caducados (no crítico):", error instanceof Error ? error.message : error);
  }
}

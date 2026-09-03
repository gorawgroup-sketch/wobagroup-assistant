import { leerFilas, agregarFila, eliminarFila } from "../google/sheetsKeyValueStore";

/** Sheets, no un archivo local — ver core/jobs/cashflowAnnotationActionStore.ts para el bug real que esto corrige. */
export interface PendienteEdicionBorrador {
  chatId: number;
  borradorId: string;
  creadoEn: number;
}

const TAB_NAME = "_pendientes_edicion_borrador";
const HEADERS = ["chatId", "borradorId", "creadoEn"];
const NUM_COLS = HEADERS.length;
// 24h — pedido explícito de Carlos (mismo criterio en todos los
// "pendiente_*", ver pendienteCapturaEmpresaStore.ts).
const TTL_MS = 24 * 60 * 60 * 1000;

function filaAObjeto(valores: string[]): PendienteEdicionBorrador {
  return { chatId: Number(valores[0]), borradorId: valores[1], creadoEn: Number(valores[2]) };
}

function objetoAFila(p: PendienteEdicionBorrador): (string | number)[] {
  return [p.chatId, p.borradorId, p.creadoEn];
}

async function leerVigentes(): Promise<{ rowIndex: number; pendiente: PendienteEdicionBorrador }[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  return filas
    .map((f) => ({ rowIndex: f.rowIndex, pendiente: filaAObjeto(f.valores) }))
    .filter((f) => ahora - f.pendiente.creadoEn <= TTL_MS);
}

export async function guardarPendienteEdicionBorrador(chatId: number, borradorId: string): Promise<void> {
  const vigentes = await leerVigentes();
  const previo = vigentes.find((f) => f.pendiente.chatId === chatId);
  if (previo) {
    await eliminarFila(TAB_NAME, previo.rowIndex, HEADERS);
  }
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila({ chatId, borradorId, creadoEn: Date.now() }));
}

export async function consumirPendienteEdicionBorrador(
  chatId: number
): Promise<PendienteEdicionBorrador | undefined> {
  const vigentes = await leerVigentes();
  const fila = vigentes.find((f) => f.pendiente.chatId === chatId);
  if (!fila) return undefined;
  await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
  return fila.pendiente;
}

/** Lectura sin consumir — para el resumen diario de pendientes (ver core/jobs/resumenPendientesDiario.ts). */
export async function obtenerPendienteEdicionBorradorPorChat(chatId: number): Promise<PendienteEdicionBorrador | undefined> {
  const vigentes = await leerVigentes();
  return vigentes.find((f) => f.pendiente.chatId === chatId)?.pendiente;
}

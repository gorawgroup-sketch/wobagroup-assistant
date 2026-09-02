import { leerFilas, agregarFila, eliminarFila } from "../google/sheetsKeyValueStore";

/** Sheets, no un archivo local — ver cashflowAnnotationActionStore.ts para el porqué (mismo bug real, mismo fix). */
export interface PendienteOrientacionAnotacion {
  chatId: number;
  messageId: number;
  ubicacion: string;
  detalle: string;
  recomendacion: string;
  creadoEn: number;
}

const TAB_NAME = "_pendientes_orientacion_anotacion_cashflow";
const HEADERS = ["chatId", "messageId", "ubicacion", "detalle", "recomendacion", "creadoEn"];
const NUM_COLS = HEADERS.length;
const TTL_MS = 30 * 60 * 1000; // 30 min — se espera respuesta casi inmediata

function filaAObjeto(valores: string[]): PendienteOrientacionAnotacion {
  return {
    chatId: Number(valores[0]),
    messageId: Number(valores[1]),
    ubicacion: valores[2],
    detalle: valores[3],
    recomendacion: valores[4],
    creadoEn: Number(valores[5]),
  };
}

function objetoAFila(p: PendienteOrientacionAnotacion): (string | number)[] {
  return [p.chatId, p.messageId, p.ubicacion, p.detalle, p.recomendacion, p.creadoEn];
}

async function leerVigentes(): Promise<{ rowIndex: number; pendiente: PendienteOrientacionAnotacion }[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  return filas
    .map((f) => ({ rowIndex: f.rowIndex, pendiente: filaAObjeto(f.valores) }))
    .filter((f) => ahora - f.pendiente.creadoEn <= TTL_MS);
}

export async function guardarPendienteOrientacionAnotacion(
  datos: Omit<PendienteOrientacionAnotacion, "creadoEn">
): Promise<void> {
  // Reemplaza cualquier pendiente previo del mismo chat (mismo criterio que emailOrientationStore: se espera
  // una única orientación en curso a la vez por chat, sin cruzarse con otra).
  const vigentes = await leerVigentes();
  const previo = vigentes.find((f) => f.pendiente.chatId === datos.chatId);
  if (previo) {
    await eliminarFila(TAB_NAME, previo.rowIndex, HEADERS);
  }
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila({ ...datos, creadoEn: Date.now() }));
}

export async function consumirPendienteOrientacionAnotacion(
  chatId: number
): Promise<PendienteOrientacionAnotacion | undefined> {
  const vigentes = await leerVigentes();
  const fila = vigentes.find((f) => f.pendiente.chatId === chatId);
  if (!fila) return undefined;
  await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
  return fila.pendiente;
}

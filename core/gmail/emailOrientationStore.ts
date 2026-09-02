import { leerFilas, agregarFila, eliminarFila } from "../google/sheetsKeyValueStore";

/** Sheets, no un archivo local — ver core/jobs/cashflowAnnotationActionStore.ts para el bug real que esto corrige. */
export interface PendienteOrientacionCorreo {
  chatId: number;
  messageId: number;
  de: string;
  asunto: string;
  resumen: string;
  threadId?: string;
  messageIdHeader?: string;
  creadoEn: number;
}

const TAB_NAME = "_pendientes_orientacion_correo";
const HEADERS = ["chatId", "messageId", "de", "asunto", "resumen", "threadId", "messageIdHeader", "creadoEn"];
const NUM_COLS = HEADERS.length;
// 24h — pedido explícito de Carlos (mismo criterio en todos los
// "pendiente_*", ver pendienteCapturaEmpresaStore.ts).
const TTL_MS = 24 * 60 * 60 * 1000;

function filaAObjeto(valores: string[]): PendienteOrientacionCorreo {
  return {
    chatId: Number(valores[0]),
    messageId: Number(valores[1]),
    de: valores[2],
    asunto: valores[3],
    resumen: valores[4],
    threadId: valores[5] || undefined,
    messageIdHeader: valores[6] || undefined,
    creadoEn: Number(valores[7]),
  };
}

function objetoAFila(p: PendienteOrientacionCorreo): (string | number)[] {
  return [p.chatId, p.messageId, p.de, p.asunto, p.resumen, p.threadId ?? "", p.messageIdHeader ?? "", p.creadoEn];
}

async function leerVigentes(): Promise<{ rowIndex: number; pendiente: PendienteOrientacionCorreo }[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  return filas
    .map((f) => ({ rowIndex: f.rowIndex, pendiente: filaAObjeto(f.valores) }))
    .filter((f) => ahora - f.pendiente.creadoEn <= TTL_MS);
}

export async function guardarPendienteOrientacionCorreo(
  datos: Omit<PendienteOrientacionCorreo, "creadoEn">
): Promise<void> {
  const vigentes = await leerVigentes();
  const previo = vigentes.find((f) => f.pendiente.chatId === datos.chatId);
  if (previo) {
    await eliminarFila(TAB_NAME, previo.rowIndex, HEADERS);
  }
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila({ ...datos, creadoEn: Date.now() }));
}

export async function consumirPendienteOrientacionCorreo(
  chatId: number
): Promise<PendienteOrientacionCorreo | undefined> {
  const vigentes = await leerVigentes();
  const fila = vigentes.find((f) => f.pendiente.chatId === chatId);
  if (!fila) return undefined;
  await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
  return fila.pendiente;
}

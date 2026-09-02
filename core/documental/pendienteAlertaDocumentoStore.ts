import { leerFilas, agregarFila, eliminarFila } from "../google/sheetsKeyValueStore";

/** Espera la respuesta de texto libre tras pulsar "⏰ Crear alerta" — ver documentCallbackHandler.ts. */
export interface PendienteAlertaDocumento {
  chatId: number;
  nombreArchivoOriginal: string;
  empresa: string;
  tipoDocumento: string;
  creadoEn: number;
}

const TAB_NAME = "_pendientes_alerta_documento";
const HEADERS = ["chatId", "nombreArchivoOriginal", "empresa", "tipoDocumento", "creadoEn"];
const NUM_COLS = HEADERS.length;
const TTL_MS = 30 * 60 * 1000;

function filaAObjeto(valores: string[]): PendienteAlertaDocumento {
  return {
    chatId: Number(valores[0]),
    nombreArchivoOriginal: valores[1],
    empresa: valores[2],
    tipoDocumento: valores[3],
    creadoEn: Number(valores[4]),
  };
}

function objetoAFila(p: PendienteAlertaDocumento): (string | number)[] {
  return [p.chatId, p.nombreArchivoOriginal, p.empresa, p.tipoDocumento, p.creadoEn];
}

async function leerVigentes(): Promise<{ rowIndex: number; pendiente: PendienteAlertaDocumento }[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  return filas
    .map((f) => ({ rowIndex: f.rowIndex, pendiente: filaAObjeto(f.valores) }))
    .filter((f) => ahora - f.pendiente.creadoEn <= TTL_MS);
}

export async function guardarPendienteAlertaDocumento(datos: Omit<PendienteAlertaDocumento, "creadoEn">): Promise<void> {
  const vigentes = await leerVigentes();
  const previo = vigentes.find((f) => f.pendiente.chatId === datos.chatId);
  if (previo) await eliminarFila(TAB_NAME, previo.rowIndex, HEADERS);
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila({ ...datos, creadoEn: Date.now() }));
}

export async function consumirPendienteAlertaDocumento(chatId: number): Promise<PendienteAlertaDocumento | undefined> {
  const vigentes = await leerVigentes();
  const fila = vigentes.find((f) => f.pendiente.chatId === chatId);
  if (!fila) return undefined;
  await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
  return fila.pendiente;
}

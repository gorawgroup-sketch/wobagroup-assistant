import { leerFilas, agregarFila, eliminarFila } from "../google/sheetsKeyValueStore";

/** Espera la respuesta de texto libre tras pulsar "📚 Enseñar regla" — ver documentCallbackHandler.ts. */
export interface PendienteReglaClasificacion {
  chatId: number;
  empresa: string;
  tipoDocumento: string;
  carpetaDestino: string;
  nombreArchivoOriginal: string;
  creadoEn: number;
}

const TAB_NAME = "_pendientes_regla_clasificacion";
const HEADERS = ["chatId", "empresa", "tipoDocumento", "carpetaDestino", "nombreArchivoOriginal", "creadoEn"];
const NUM_COLS = HEADERS.length;
// 24h — pedido explícito de Carlos (mismo criterio en todos los
// "pendiente_*", ver pendienteCapturaEmpresaStore.ts): procesa el correo/
// documentos entrantes por lotes, no de inmediato.
const TTL_MS = 24 * 60 * 60 * 1000;

function filaAObjeto(valores: string[]): PendienteReglaClasificacion {
  return {
    chatId: Number(valores[0]),
    empresa: valores[1],
    tipoDocumento: valores[2],
    carpetaDestino: valores[3],
    nombreArchivoOriginal: valores[4],
    creadoEn: Number(valores[5]),
  };
}

function objetoAFila(p: PendienteReglaClasificacion): (string | number)[] {
  return [p.chatId, p.empresa, p.tipoDocumento, p.carpetaDestino, p.nombreArchivoOriginal, p.creadoEn];
}

async function leerVigentes(): Promise<{ rowIndex: number; pendiente: PendienteReglaClasificacion }[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  return filas
    .map((f) => ({ rowIndex: f.rowIndex, pendiente: filaAObjeto(f.valores) }))
    .filter((f) => ahora - f.pendiente.creadoEn <= TTL_MS);
}

export async function guardarPendienteReglaClasificacion(
  datos: Omit<PendienteReglaClasificacion, "creadoEn">
): Promise<void> {
  const vigentes = await leerVigentes();
  const previo = vigentes.find((f) => f.pendiente.chatId === datos.chatId);
  if (previo) await eliminarFila(TAB_NAME, previo.rowIndex, HEADERS);
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila({ ...datos, creadoEn: Date.now() }));
}

export async function consumirPendienteReglaClasificacion(
  chatId: number
): Promise<PendienteReglaClasificacion | undefined> {
  const vigentes = await leerVigentes();
  const fila = vigentes.find((f) => f.pendiente.chatId === chatId);
  if (!fila) return undefined;
  await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
  return fila.pendiente;
}

import { leerFilas, agregarFila, eliminarFila } from "../google/sheetsKeyValueStore";

/**
 * Espera la respuesta de texto libre tras pulsar "✏️ Otras acciones" en una
 * propuesta de gasto que vino de un correo (ver gastoCallbackHandler.ts) —
 * pedido explícito de Carlos, tras un caso real (INDUBUILDING LUARCA): un
 * correo con una factura solo dejaba registrar el gasto, sin poder también
 * responder el correo o dejar un recordatorio para conciliar — "puede ser 1
 * sola cosa... o pueden ser varias". Mismo patrón que
 * pendienteAjusteMontoGastoStore.ts — store separado para no mezclar esta
 * pregunta de texto libre con la de ajustar el monto.
 */
export interface PendienteAccionGasto {
  chatId: number;
  propuestaId: string;
  creadoEn: number;
}

const TAB_NAME = "_pendientes_accion_gasto";
const HEADERS = ["chatId", "propuestaId", "creadoEn"];
const NUM_COLS = HEADERS.length;
// 24h — mismo criterio que el resto de "pendiente_*" (ver pendienteCapturaEmpresaStore.ts).
const TTL_MS = 24 * 60 * 60 * 1000;

function filaAObjeto(valores: string[]): PendienteAccionGasto {
  return { chatId: Number(valores[0]), propuestaId: valores[1], creadoEn: Number(valores[2]) };
}

function objetoAFila(p: PendienteAccionGasto): (string | number)[] {
  return [p.chatId, p.propuestaId, p.creadoEn];
}

async function leerVigentes(): Promise<{ rowIndex: number; pendiente: PendienteAccionGasto }[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  return filas
    .map((f) => ({ rowIndex: f.rowIndex, pendiente: filaAObjeto(f.valores) }))
    .filter((f) => ahora - f.pendiente.creadoEn <= TTL_MS);
}

export async function guardarPendienteAccionGasto(chatId: number, propuestaId: string): Promise<void> {
  const vigentes = await leerVigentes();
  const previo = vigentes.find((f) => f.pendiente.chatId === chatId);
  if (previo) {
    await eliminarFila(TAB_NAME, previo.rowIndex, HEADERS);
  }
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila({ chatId, propuestaId, creadoEn: Date.now() }));
}

export async function consumirPendienteAccionGasto(chatId: number): Promise<PendienteAccionGasto | undefined> {
  const vigentes = await leerVigentes();
  const fila = vigentes.find((f) => f.pendiente.chatId === chatId);
  if (!fila) return undefined;
  await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
  return fila.pendiente;
}

/** Lectura sin consumir — para el resumen diario de pendientes (ver core/jobs/resumenPendientesDiario.ts). */
export async function obtenerPendienteAccionGastoPorChat(chatId: number): Promise<PendienteAccionGasto | undefined> {
  const vigentes = await leerVigentes();
  return vigentes.find((f) => f.pendiente.chatId === chatId)?.pendiente;
}

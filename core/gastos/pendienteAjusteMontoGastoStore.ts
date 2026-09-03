import { leerFilas, agregarFila, eliminarFila } from "../google/sheetsKeyValueStore";

/**
 * Espera la respuesta de texto libre tras pulsar "💰 Ajustar monto" en una
 * propuesta de gasto (ver gastoCallbackHandler.ts) — pedido explícito de
 * Carlos, tras un caso real: una cuota de comunidad se paga a medias con
 * otra parte, así que el gasto a registrar es la MITAD del importe real de
 * la factura, y no había ninguna forma de ajustarlo antes de crear el
 * gasto (la corrección existente solo cambia empresa/concepto, nunca el
 * monto). Mismo patrón que pendienteCorreccionGastoStore.ts — store
 * separado (no reutilizado) para no mezclar dos preguntas de texto libre
 * distintas bajo el mismo pendiente.
 */
export interface PendienteAjusteMontoGasto {
  chatId: number;
  propuestaId: string;
  creadoEn: number;
}

const TAB_NAME = "_pendientes_ajuste_monto_gasto";
const HEADERS = ["chatId", "propuestaId", "creadoEn"];
const NUM_COLS = HEADERS.length;
// 24h — mismo criterio que el resto de "pendiente_*" (ver pendienteCapturaEmpresaStore.ts).
const TTL_MS = 24 * 60 * 60 * 1000;

function filaAObjeto(valores: string[]): PendienteAjusteMontoGasto {
  return { chatId: Number(valores[0]), propuestaId: valores[1], creadoEn: Number(valores[2]) };
}

function objetoAFila(p: PendienteAjusteMontoGasto): (string | number)[] {
  return [p.chatId, p.propuestaId, p.creadoEn];
}

async function leerVigentes(): Promise<{ rowIndex: number; pendiente: PendienteAjusteMontoGasto }[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  return filas
    .map((f) => ({ rowIndex: f.rowIndex, pendiente: filaAObjeto(f.valores) }))
    .filter((f) => ahora - f.pendiente.creadoEn <= TTL_MS);
}

export async function guardarPendienteAjusteMontoGasto(chatId: number, propuestaId: string): Promise<void> {
  const vigentes = await leerVigentes();
  const previo = vigentes.find((f) => f.pendiente.chatId === chatId);
  if (previo) {
    await eliminarFila(TAB_NAME, previo.rowIndex, HEADERS);
  }
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila({ chatId, propuestaId, creadoEn: Date.now() }));
}

export async function consumirPendienteAjusteMontoGasto(chatId: number): Promise<PendienteAjusteMontoGasto | undefined> {
  const vigentes = await leerVigentes();
  const fila = vigentes.find((f) => f.pendiente.chatId === chatId);
  if (!fila) return undefined;
  await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
  return fila.pendiente;
}

/** Lectura sin consumir — para el resumen diario de pendientes (ver core/jobs/resumenPendientesDiario.ts). */
export async function obtenerPendienteAjusteMontoGastoPorChat(chatId: number): Promise<PendienteAjusteMontoGasto | undefined> {
  const vigentes = await leerVigentes();
  return vigentes.find((f) => f.pendiente.chatId === chatId)?.pendiente;
}

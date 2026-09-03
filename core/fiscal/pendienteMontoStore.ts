import { leerFilas, agregarFila, eliminarFila } from "../google/sheetsKeyValueStore";
import type { TipoRecurrencia } from "./calendario";

/** Sheets, no un archivo local — ver core/jobs/cashflowAnnotationActionStore.ts para el bug real que esto corrige. */
export interface PendienteMontoPago {
  chatId: number;
  messageId: number;
  entradaId: string;
  concepto: string;
  tipo: TipoRecurrencia;
  empresaHolded: "WOBA" | "EWORKS" | "Footprint";
  proveedor?: string;
  fechaVencimiento: string; // YYYY-MM-DD
  creadoEn: number;
}

const TAB_NAME = "_pendientes_monto_pago";
const HEADERS = ["chatId", "messageId", "entradaId", "concepto", "tipo", "empresaHolded", "proveedor", "fechaVencimiento", "creadoEn"];
const NUM_COLS = HEADERS.length;
// 24h — pedido explícito de Carlos (mismo criterio en todos los
// "pendiente_*", ver pendienteCapturaEmpresaStore.ts).
const TTL_MS = 24 * 60 * 60 * 1000;

function filaAObjeto(valores: string[]): PendienteMontoPago {
  return {
    chatId: Number(valores[0]),
    messageId: Number(valores[1]),
    entradaId: valores[2],
    concepto: valores[3],
    tipo: valores[4] as TipoRecurrencia,
    empresaHolded: valores[5] as PendienteMontoPago["empresaHolded"],
    proveedor: valores[6] || undefined,
    fechaVencimiento: valores[7],
    creadoEn: Number(valores[8]),
  };
}

function objetoAFila(p: PendienteMontoPago): (string | number)[] {
  return [p.chatId, p.messageId, p.entradaId, p.concepto, p.tipo, p.empresaHolded, p.proveedor ?? "", p.fechaVencimiento, p.creadoEn];
}

async function leerVigentes(): Promise<{ rowIndex: number; pendiente: PendienteMontoPago }[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  return filas
    .map((f) => ({ rowIndex: f.rowIndex, pendiente: filaAObjeto(f.valores) }))
    .filter((f) => ahora - f.pendiente.creadoEn <= TTL_MS);
}

export async function guardarPendienteMontoPago(datos: Omit<PendienteMontoPago, "creadoEn">): Promise<void> {
  const vigentes = await leerVigentes();
  const previo = vigentes.find((f) => f.pendiente.chatId === datos.chatId);
  if (previo) {
    await eliminarFila(TAB_NAME, previo.rowIndex, HEADERS);
  }
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila({ ...datos, creadoEn: Date.now() }));
}

export async function consumirPendienteMontoPago(chatId: number): Promise<PendienteMontoPago | undefined> {
  const vigentes = await leerVigentes();
  const fila = vigentes.find((f) => f.pendiente.chatId === chatId);
  if (!fila) return undefined;
  await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
  return fila.pendiente;
}

/** Lectura sin consumir — para el resumen diario de pendientes (ver core/jobs/resumenPendientesDiario.ts). */
export async function obtenerPendienteMontoPagoPorChat(chatId: number): Promise<PendienteMontoPago | undefined> {
  const vigentes = await leerVigentes();
  return vigentes.find((f) => f.pendiente.chatId === chatId)?.pendiente;
}

import { agregarFila, eliminarFila, leerFilas } from "../google/sheetsKeyValueStore";

/**
 * Gastos de correo que el operador descartó con «Cancelar».
 *
 * Caso real (Carlos, 2026-09-30): una factura de Telefónica (208,60 €) que ya estaba pagada y conciliada en Holded
 * volvía a proponerse en cada revisión, aunque la cancelara una y otra vez. «Cancelar» solo cerraba el correo en la
 * cola; nada recordaba la decisión, y el siguiente pase leía otra vez el mismo adjunto y volvía a proponerlo.
 *
 * Complementa a gastoPorCorreoStore («ya es un gasto») y documentoArchivadoPorCorreoStore («no era un gasto, se
 * archivó»): aquí, «el operador dijo que NO se registre». attachmentId = partId del adjunto; "" cuando el gasto se
 * detectó en el cuerpo del correo.
 */
const TAB_NAME = "_gastos_descartados_por_operador";
const HEADERS = ["mensajeIdGmail", "attachmentId", "proveedor", "monto", "moneda", "creadoEn"];
const NUM_COLS = HEADERS.length;
const TTL_MS = 400 * 24 * 60 * 60 * 1000;

export interface GastoDescartadoPorOperador { proveedor: string; monto: number; moneda: string; creadoEn: number }

export async function registrarGastoDescartadoPorOperador(datos: {
  mensajeIdGmail: string; attachmentId?: string; proveedor: string; monto: number; moneda: string;
}): Promise<void> {
  if (!datos.mensajeIdGmail) return;
  await purgarVencidos().catch((error) =>
    console.error("[gastoDescartadoPorOperadorStore] Error purgando registros vencidos (no crítico):", error)
  );
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, [
    datos.mensajeIdGmail, datos.attachmentId ?? "", datos.proveedor, datos.monto, datos.moneda, Date.now(),
  ]);
}

async function purgarVencidos(): Promise<void> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  const vencidas = filas.filter((f) => ahora - (Number(f.valores[5]) || 0) > TTL_MS).sort((a, b) => b.rowIndex - a.rowIndex);
  for (const fila of vencidas) await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
}

/** El descarte del operador para este correo y adjunto ("" = cuerpo), si existe y sigue vigente. */
export async function gastoDescartadoPorOperador(
  mensajeIdGmail: string, attachmentId: string | undefined
): Promise<GastoDescartadoPorOperador | undefined> {
  if (!mensajeIdGmail) return undefined;
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  const fila = filas.find((f) =>
    f.valores[0] === mensajeIdGmail && (f.valores[1] ?? "") === (attachmentId ?? "") && ahora - (Number(f.valores[5]) || 0) <= TTL_MS
  );
  if (!fila) return undefined;
  return { proveedor: fila.valores[2] ?? "", monto: Number(fila.valores[3]) || 0, moneda: fila.valores[4] ?? "", creadoEn: Number(fila.valores[5]) || 0 };
}

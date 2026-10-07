import { actualizarFila, agregarFilaAtomica, eliminarFila, leerFilas } from "../google/sheetsKeyValueStore";
import { conMutex } from "../utils/asyncMutex";

/**
 * «Todo lo que mande ahora es conocimiento»: lo deja armado /conocimiento y lo consumen los siguientes mensajes, documentos y enlaces de
 * ese chat hasta que se pulse «Terminar» o pasen 30 min sin enviar nada (cada elemento guardado renueva el plazo). Vive en Sheets para
 * sobrevivir a un despliegue entre el comando y lo que se envía después.
 */
const TAB_NAME = "_modo_conocimiento";
const HEADERS = ["chatId", "empresas", "expiraEn"];
const NUM_COLS = HEADERS.length;
const MUTEX = `conocimiento-modo:${TAB_NAME}`;
export const VIGENCIA_MODO_CONOCIMIENTO_MS = 30 * 60 * 1000;

export interface ModoConocimiento { empresas: string[]; expiraEn: number }

export async function activarModoConocimiento(chatId: number, empresas: string[], ahora = Date.now()): Promise<void> {
  await conMutex(MUTEX, async () => {
    const fila = (await leerFilas(TAB_NAME, NUM_COLS, HEADERS)).find((f) => f.valores[0] === String(chatId));
    const valores = [String(chatId), empresas.join(","), ahora + VIGENCIA_MODO_CONOCIMIENTO_MS];
    if (fila) await actualizarFila(TAB_NAME, fila.rowIndex, NUM_COLS, valores);
    else await agregarFilaAtomica(TAB_NAME, NUM_COLS, HEADERS, valores);
  });
}

/** El modo de este chat si sigue vigente. No lo consume. */
export async function leerModoConocimiento(chatId: number, ahora = Date.now()): Promise<ModoConocimiento | undefined> {
  const fila = (await leerFilas(TAB_NAME, NUM_COLS, HEADERS)).find((f) => f.valores[0] === String(chatId));
  if (!fila || !(Number(fila.valores[2]) > ahora)) return undefined;
  const empresas = String(fila.valores[1] ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  return { empresas: empresas.length ? empresas : ["General"], expiraEn: Number(fila.valores[2]) };
}

export async function cerrarModoConocimiento(chatId: number): Promise<void> {
  await conMutex(MUTEX, async () => {
    const fila = (await leerFilas(TAB_NAME, NUM_COLS, HEADERS)).find((f) => f.valores[0] === String(chatId));
    if (fila) await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
  });
}

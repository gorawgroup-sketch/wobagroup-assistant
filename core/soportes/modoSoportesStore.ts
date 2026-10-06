import { actualizarFila, agregarFilaAtomica, eliminarFila, leerFilas } from "../google/sheetsKeyValueStore";
import { conMutex } from "../utils/asyncMutex";
import type { Empresa } from "../holded/client";

/**
 * «Estoy esperando el CSV de Revolut de esta empresa»: lo deja armado /soportes (o su botón de empresa) y lo consume el
 * siguiente CSV de ese chat. Así la empresa no depende de que el texto del archivo esté bien escrito. Una sola vez por
 * CSV: tras analizarlo se cierra, y el siguiente exige elegir empresa otra vez (un CSV de EWORKS no se lee por error
 * como de WOBA). Vive en Sheets para sobrevivir a un despliegue entre el botón y la subida del archivo.
 */
const TAB_NAME = "_modo_soportes";
const HEADERS = ["chatId", "empresa", "expiraEn"];
const NUM_COLS = HEADERS.length;
const MUTEX = `soportes-modo:${TAB_NAME}`;
export const VIGENCIA_MODO_MS = 3 * 60 * 60 * 1000;

const EMPRESAS: Empresa[] = ["WOBA", "EWORKS", "Footprint"];

export async function activarModoSoportes(chatId: number, empresa: Empresa, ahora = Date.now()): Promise<void> {
  await conMutex(MUTEX, async () => {
    const fila = (await leerFilas(TAB_NAME, NUM_COLS, HEADERS)).find((f) => f.valores[0] === String(chatId));
    const valores = [String(chatId), empresa, ahora + VIGENCIA_MODO_MS];
    if (fila) await actualizarFila(TAB_NAME, fila.rowIndex, NUM_COLS, valores);
    else await agregarFilaAtomica(TAB_NAME, NUM_COLS, HEADERS, valores);
  });
}

/** La empresa que este chat dijo que sube, si sigue vigente. No la consume. */
export async function leerModoSoportes(chatId: number, ahora = Date.now()): Promise<Empresa | undefined> {
  const fila = (await leerFilas(TAB_NAME, NUM_COLS, HEADERS)).find((f) => f.valores[0] === String(chatId));
  if (!fila) return undefined;
  const empresa = fila.valores[1] as Empresa;
  return EMPRESAS.includes(empresa) && Number(fila.valores[2]) > ahora ? empresa : undefined;
}

export async function cerrarModoSoportes(chatId: number): Promise<void> {
  await conMutex(MUTEX, async () => {
    const fila = (await leerFilas(TAB_NAME, NUM_COLS, HEADERS)).find((f) => f.valores[0] === String(chatId));
    if (fila) await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
  });
}

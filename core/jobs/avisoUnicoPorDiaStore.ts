import { leerFilas, agregarFila, actualizarFila } from "../google/sheetsKeyValueStore";
import { fechaHoyEspana } from "../utils/diaHabil";

/**
 * Pedido explícito de Carlos: "he recibido muchos avisos de que tengo
 * mails sin revisar y no es necesario, con 1 al día es suficiente" — el
 * único cron que puede repetir el MISMO aviso varias veces en un día es
 * revisarCorreoNuevo (corre cada hora); el resto de los crons informativos
 * ya solo corren una vez al día. Este store guarda, por tema+chat, la
 * última fecha (hora de Madrid) en que se mandó ese aviso, para que un
 * cron que corre más de una vez al día nunca repita el mismo tema el mismo
 * día — sin importar cuántas veces corra mientras tanto.
 */
const TAB_NAME = "_avisos_unicos_por_dia";
const HEADERS = ["tema", "chatId", "ultimaFecha"];
const NUM_COLS = HEADERS.length;

async function leerFila(tema: string, chatId: number): Promise<{ rowIndex: number; ultimaFecha: string } | undefined> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const fila = filas.find((f) => f.valores[0] === tema && Number(f.valores[1]) === chatId);
  return fila ? { rowIndex: fila.rowIndex, ultimaFecha: fila.valores[2] || "" } : undefined;
}

/** true si este `tema` ya se avisó a `chatId` hoy (hora de Madrid). */
export async function yaSeAvisoHoy(tema: string, chatId: number): Promise<boolean> {
  const fila = await leerFila(tema, chatId);
  return fila?.ultimaFecha === fechaHoyEspana();
}

/** Marca `tema` como avisado hoy para `chatId` — crea o actualiza la fila. */
export async function marcarAvisadoHoy(tema: string, chatId: number): Promise<void> {
  const fila = await leerFila(tema, chatId);
  const hoy = fechaHoyEspana();

  if (fila) {
    await actualizarFila(TAB_NAME, fila.rowIndex, NUM_COLS, [tema, chatId, hoy]);
  } else {
    await agregarFila(TAB_NAME, NUM_COLS, HEADERS, [tema, chatId, hoy]);
  }
}

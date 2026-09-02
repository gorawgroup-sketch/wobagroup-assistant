import { randomUUID } from "node:crypto";
import { leerFilas, agregarFila, actualizarFila, eliminarFila } from "../google/sheetsKeyValueStore";
import type { Empresa } from "../holded/client";

/** Sheets, no un archivo local — ver core/jobs/cashflowAnnotationActionStore.ts para el bug real que esto corrige. */
export interface PropuestaReporteContable {
  id: string;
  chatId: number;
  messageId: number;
  empresa: Empresa;
  desde: string;
  hasta: string;
  correoDestino: string;
  creadoEn: number;
}

const TAB_NAME = "_propuestas_reporte_contable";
const HEADERS = ["id", "chatId", "messageId", "empresa", "desde", "hasta", "correoDestino", "creadoEn"];
const NUM_COLS = HEADERS.length;

// El archivo NUNCA se persiste aquí (solo los parámetros) — al aprobar, se
// regenera el Excel/PDF en el momento, así que no hace falta guardar
// binarios en ningún store. 60 min: da tiempo de sobra a que alguien vea la
// notificación y confirme, sin quedar viva indefinidamente.
const TTL_MS = 60 * 60 * 1000;

function filaAObjeto(valores: string[]): PropuestaReporteContable {
  return {
    id: valores[0],
    chatId: Number(valores[1]),
    messageId: Number(valores[2]),
    empresa: valores[3] as Empresa,
    desde: valores[4],
    hasta: valores[5],
    correoDestino: valores[6],
    creadoEn: Number(valores[7]),
  };
}

function objetoAFila(p: PropuestaReporteContable): (string | number)[] {
  return [p.id, p.chatId, p.messageId, p.empresa, p.desde, p.hasta, p.correoDestino, p.creadoEn];
}

async function leerVigentes(): Promise<{ rowIndex: number; propuesta: PropuestaReporteContable }[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  return filas
    .map((f) => ({ rowIndex: f.rowIndex, propuesta: filaAObjeto(f.valores) }))
    .filter((f) => ahora - f.propuesta.creadoEn <= TTL_MS);
}

export async function crearPropuestaReporteContable(
  datos: Omit<PropuestaReporteContable, "id" | "creadoEn">
): Promise<PropuestaReporteContable> {
  const propuesta: PropuestaReporteContable = { ...datos, id: randomUUID(), creadoEn: Date.now() };
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila(propuesta));
  return propuesta;
}

export async function actualizarMessageIdReporteContable(id: string, messageId: number): Promise<void> {
  const vigentes = await leerVigentes();
  const fila = vigentes.find((f) => f.propuesta.id === id);
  if (!fila) return;
  await actualizarFila(TAB_NAME, fila.rowIndex, NUM_COLS, objetoAFila({ ...fila.propuesta, messageId }));
}

/** Consume (lee y elimina) una propuesta por id. undefined si no existe o venció. */
export async function consumirPropuestaReporteContable(id: string): Promise<PropuestaReporteContable | undefined> {
  const vigentes = await leerVigentes();
  const fila = vigentes.find((f) => f.propuesta.id === id);
  if (!fila) return undefined;
  await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
  return fila.propuesta;
}

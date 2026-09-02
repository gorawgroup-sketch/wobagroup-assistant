import { randomUUID } from "node:crypto";
import { leerFilas, agregarFila, actualizarFila, eliminarFila } from "../google/sheetsKeyValueStore";

/**
 * Pedido explícito de Carlos: cuando revisarAnotacionesCashflow.ts le manda
 * una recomendación sobre una anotación del cashflow, antes no había ninguna
 * forma de actuar sobre eso — solo texto plano, sin botones. Este store
 * (y cashflowAnnotationCallbackHandler.ts) le agregan el mismo patrón de
 * "✅ Hazlo tú / ✏️ Dar instrucciones / ℹ️ Dejar como informativo".
 *
 * Sheets, no un archivo local — bug real encontrado en vivo (2026-09-02):
 * la versión anterior de este store vivía en data/*.json, y el botón
 * "Dar instrucciones" pulsado más tarde no encontró la propuesta porque se
 * creó en un proceso con disco efímero distinto (ver
 * core/google/sheetsKeyValueStore.ts para el detalle completo). Un
 * redeploy real durante desarrollo activo habría causado exactamente lo
 * mismo en producción.
 */
export interface PropuestaAccionAnotacion {
  id: string;
  chatId: number;
  messageId: number;
  ubicacion: string;
  detalle: string;
  recomendacion: string;
  creadoEn: number;
}

const TAB_NAME = "_propuestas_anotacion_cashflow";
const HEADERS = ["id", "chatId", "messageId", "ubicacion", "detalle", "recomendacion", "creadoEn"];
const NUM_COLS = HEADERS.length;
const TTL_MS = 48 * 60 * 60 * 1000; // 48 horas

function filaAObjeto(valores: string[]): PropuestaAccionAnotacion {
  return {
    id: valores[0],
    chatId: Number(valores[1]),
    messageId: Number(valores[2]),
    ubicacion: valores[3],
    detalle: valores[4],
    recomendacion: valores[5],
    creadoEn: Number(valores[6]),
  };
}

function objetoAFila(p: PropuestaAccionAnotacion): (string | number)[] {
  return [p.id, p.chatId, p.messageId, p.ubicacion, p.detalle, p.recomendacion, p.creadoEn];
}

async function leerVigentes(): Promise<{ rowIndex: number; propuesta: PropuestaAccionAnotacion }[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  return filas
    .map((f) => ({ rowIndex: f.rowIndex, propuesta: filaAObjeto(f.valores) }))
    .filter((f) => ahora - f.propuesta.creadoEn <= TTL_MS);
}

export async function crearPropuestaAccionAnotacion(
  datos: Omit<PropuestaAccionAnotacion, "id" | "creadoEn">
): Promise<PropuestaAccionAnotacion> {
  const propuesta: PropuestaAccionAnotacion = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila(propuesta));
  return propuesta;
}

export async function actualizarMessageIdAccionAnotacion(id: string, messageId: number): Promise<void> {
  const vigentes = await leerVigentes();
  const fila = vigentes.find((f) => f.propuesta.id === id);
  if (!fila) return;
  const actualizada = { ...fila.propuesta, messageId };
  await actualizarFila(TAB_NAME, fila.rowIndex, NUM_COLS, objetoAFila(actualizada));
}

/** Devuelve la propuesta y la elimina (se llama al descartar o proceder). */
export async function consumirPropuestaAccionAnotacion(id: string): Promise<PropuestaAccionAnotacion | undefined> {
  const vigentes = await leerVigentes();
  const fila = vigentes.find((f) => f.propuesta.id === id);
  if (!fila) return undefined;
  await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
  return fila.propuesta;
}

import { randomUUID } from "node:crypto";
import { leerFilas, agregarFila, actualizarFila, eliminarFila } from "../google/sheetsKeyValueStore";
import type { TipoCorreo } from "./classifyEmail";

/** Sheets, no un archivo local — ver core/jobs/cashflowAnnotationActionStore.ts para el bug real que esto corrige. */
export interface PropuestaAccionCorreo {
  id: string;
  chatId: number;
  messageId: number;
  de: string;
  asunto: string;
  tipo: TipoCorreo;
  resumen: string;
  accionSugerida: string;
  threadId: string;
  messageIdHeader: string;
  creadoEn: number;
  /** Gmail message id (interno, no el header Message-ID) — para poder releer el cuerpo completo si se elige "Guardar como conocimiento". */
  mensajeId: string;
  /**
   * true SOLO si esta propuesta viene de procesarSiguienteCorreoActivo (la cola de revisión
   * horaria) — decide si, al resolverse (email_proceder/descartar/guardar/orientar), se avanza
   * colaRevisionStore (ver avanzarColaCorreoSiActivo en emailCallbackHandler.ts). Antes este
   * campo no existía porque PropuestaAccionCorreo SOLO se creaba desde ahí — pedido explícito de
   * Carlos: poder decirle "vamos al correo de X, léelo" fuera de la cola (revisar_correo_puntual)
   * creó un segundo origen real, y sin este campo esa propuesta puntual avanzaría/rompería el
   * correo activo de la cola si hubiera uno en curso al mismo tiempo — mismo patrón ya usado por
   * PropuestaGasto.deColaCorreo.
   */
  deColaCorreo: boolean;
}

const TAB_NAME = "_propuestas_correo";
const HEADERS = [
  "id",
  "chatId",
  "messageId",
  "de",
  "asunto",
  "tipo",
  "resumen",
  "accionSugerida",
  "threadId",
  "messageIdHeader",
  "creadoEn",
  "mensajeId",
  "deColaCorreo",
];
const NUM_COLS = HEADERS.length;
const TTL_MS = 48 * 60 * 60 * 1000; // 48 horas

function filaAObjeto(valores: string[]): PropuestaAccionCorreo {
  return {
    id: valores[0],
    chatId: Number(valores[1]),
    messageId: Number(valores[2]),
    de: valores[3],
    asunto: valores[4],
    tipo: valores[5] as TipoCorreo,
    resumen: valores[6],
    accionSugerida: valores[7],
    threadId: valores[8],
    messageIdHeader: valores[9],
    creadoEn: Number(valores[10]),
    mensajeId: valores[11] || "",
    deColaCorreo: valores[12] === "true",
  };
}

function objetoAFila(p: PropuestaAccionCorreo): (string | number)[] {
  return [
    p.id,
    p.chatId,
    p.messageId,
    p.de,
    p.asunto,
    p.tipo,
    p.resumen,
    p.accionSugerida,
    p.threadId,
    p.messageIdHeader,
    p.creadoEn,
    p.mensajeId,
    p.deColaCorreo ? "true" : "",
  ];
}

async function leerVigentes(): Promise<{ rowIndex: number; propuesta: PropuestaAccionCorreo }[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  return filas
    .map((f) => ({ rowIndex: f.rowIndex, propuesta: filaAObjeto(f.valores) }))
    .filter((f) => ahora - f.propuesta.creadoEn <= TTL_MS);
}

export async function crearPropuestaAccionCorreo(
  datos: Omit<PropuestaAccionCorreo, "id" | "creadoEn">
): Promise<PropuestaAccionCorreo> {
  const propuesta: PropuestaAccionCorreo = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila(propuesta));
  return propuesta;
}

export async function actualizarMessageIdAccionCorreo(id: string, messageId: number): Promise<void> {
  const vigentes = await leerVigentes();
  const fila = vigentes.find((f) => f.propuesta.id === id);
  if (!fila) return;
  await actualizarFila(TAB_NAME, fila.rowIndex, NUM_COLS, objetoAFila({ ...fila.propuesta, messageId }));
}

export async function obtenerPropuestaAccionCorreo(id: string): Promise<PropuestaAccionCorreo | undefined> {
  const vigentes = await leerVigentes();
  return vigentes.find((f) => f.propuesta.id === id)?.propuesta;
}

/** Devuelve la propuesta y la elimina (se llama al descartar o proceder). */
export async function consumirPropuestaAccionCorreo(id: string): Promise<PropuestaAccionCorreo | undefined> {
  const vigentes = await leerVigentes();
  const fila = vigentes.find((f) => f.propuesta.id === id);
  if (!fila) return undefined;
  await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
  return fila.propuesta;
}

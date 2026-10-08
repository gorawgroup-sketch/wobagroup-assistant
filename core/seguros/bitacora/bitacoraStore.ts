import { agregarFila, eliminarFilas, leerFilas, type FilaCruda } from "../../google/sheetsKeyValueStore";
import {
  ENTRADAS_TRAS_PODAR, MAX_AVISOS, MAX_ENTRADAS_BITACORA, MAX_EVENTOS, MAX_NOTA, MAX_NOTAS, MAX_RESUMEN, MAX_TEXTO_AVISO, ORIGENES, RESULTADOS, TAREAS_SEGUROS, TEXTO_AVISO_CORTO,
  type DetalleBitacora, type EntradaBitacora, type EntradaBitacoraConFila, type OrigenEjecucion, type ResultadoTarea, type TareaSeguros,
} from "./tipos";

/** Pestaña `_seguros_bitacora`: una fila por ejecución o decisión de Wobi Seguros. Solo se añaden filas; las más antiguas se podan. */
const TAB_NAME = "_seguros_bitacora";
const HEADERS = ["id", "cuando", "tarea", "origen", "resultado", "resumen", "detalle"];
const NUM_COLS = HEADERS.length;
/** Una celda de Sheets admite 50.000 caracteres: por debajo, con holgura, para que una fila nunca se rechace. */
const MAX_DETALLE_JSON = 45_000;

const recortar = (texto: unknown, max: number): string => {
  const limpio = String(texto ?? "").replace(/\s+/g, " ").trim();
  return limpio.length > max ? `${limpio.slice(0, max - 1).trimEnd()}…` : limpio;
};

const esInstante = (valor: unknown): valor is string => typeof valor === "string" && Number.isFinite(Date.parse(valor));

/** Acota el detalle a lo que cabe y tiene sentido guardar (los textos de los avisos conservan los saltos de línea). */
export function acotarDetalle(detalle: DetalleBitacora, maxTextoAviso = MAX_TEXTO_AVISO): DetalleBitacora {
  const salida: DetalleBitacora = {};
  if (detalle.avisos?.length) {
    salida.avisos = detalle.avisos.slice(0, MAX_AVISOS).map((a) => {
      const completo = String(a.texto ?? "").trim();
      const aviso: NonNullable<DetalleBitacora["avisos"]>[number] = { canal: "telegram", titulo: recortar(a.titulo, 160), texto: completo.slice(0, maxTextoAviso), entregado: a.entregado === true };
      if (aviso.entregado && esInstante(a.entregadoEn)) aviso.entregadoEn = new Date(a.entregadoEn).toISOString();
      if (a.truncado === true || completo.length > maxTextoAviso) aviso.truncado = true;
      return aviso;
    });
  }
  if (detalle.eventos?.length) {
    salida.eventos = detalle.eventos.slice(0, MAX_EVENTOS).map((e) => ({ accion: e.accion === "retirado" ? "retirado" : "creado", titulo: recortar(e.titulo, 200), inicio: String(e.inicio ?? "") }));
  }
  if (detalle.cifras && Object.keys(detalle.cifras).length) {
    salida.cifras = Object.fromEntries(Object.entries(detalle.cifras).filter(([, v]) => Number.isFinite(v)));
  }
  if (detalle.notas?.length) salida.notas = detalle.notas.slice(0, MAX_NOTAS).map((n) => recortar(n, MAX_NOTA));
  return salida;
}

export function entradaAFila(e: EntradaBitacora): string[] {
  let detalle = JSON.stringify(acotarDetalle(e.detalle ?? {}));
  // Si no cabe en una celda, primero se acortan los textos de los avisos (lo que más pesa); solo si aun así no cabe se descarta el detalle.
  if (detalle.length > MAX_DETALLE_JSON) detalle = JSON.stringify(acotarDetalle(e.detalle ?? {}, TEXTO_AVISO_CORTO));
  if (detalle.length > MAX_DETALLE_JSON) detalle = JSON.stringify({ notas: ["Detalle demasiado largo: no se guardó."] });
  return [e.id, e.cuando, e.tarea, e.origen, e.resultado, recortar(e.resumen, MAX_RESUMEN), detalle];
}

function leerDetalle(crudo: string | undefined): DetalleBitacora {
  if (!crudo) return {};
  try {
    const v = JSON.parse(crudo) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? acotarDetalle(v as DetalleBitacora) : {};
  } catch (error) {
    // Una celda editada a mano no puede romper toda la lectura: se muestra la entrada sin detalle.
    console.error("[bitacoraStore] Detalle ilegible en una fila (se ignora el detalle):", error instanceof Error ? error.message : error);
    return {};
  }
}

/** null si la fila no es una entrada válida (a medias o editada a mano): se ignora en vez de romper la lectura. */
export function filaAEntrada(fila: FilaCruda): EntradaBitacoraConFila | null {
  const [id, cuando, tarea, origen, resultado, resumen, detalle] = fila.valores;
  if (!id || !Number.isFinite(Date.parse(cuando ?? ""))) return null;
  if (!TAREAS_SEGUROS.includes(tarea as TareaSeguros) || !ORIGENES.includes(origen as OrigenEjecucion) || !RESULTADOS.includes(resultado as ResultadoTarea)) return null;
  return {
    id, cuando, tarea: tarea as TareaSeguros, origen: origen as OrigenEjecucion, resultado: resultado as ResultadoTarea,
    resumen: resumen ?? "", detalle: leerDetalle(detalle), rowIndex: fila.rowIndex,
  };
}

async function leerTodas(): Promise<EntradaBitacoraConFila[]> {
  return (await leerFilas(TAB_NAME, NUM_COLS, HEADERS)).map(filaAEntrada).filter((e): e is EntradaBitacoraConFila => e !== null);
}

/** Las últimas `limite` entradas, la más reciente primero. */
export async function leerBitacora(limite = 60): Promise<EntradaBitacora[]> {
  const todas = await leerTodas();
  return todas
    .sort((a, b) => Date.parse(b.cuando) - Date.parse(a.cuando))
    .slice(0, Math.max(1, limite))
    .map(({ rowIndex: _rowIndex, ...entrada }) => entrada);
}

export async function agregarEntradaBitacora(e: EntradaBitacora): Promise<void> {
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, entradaAFila(e));
}

/** Filas a borrar para quedarse con las `conservar` más recientes (puro: se prueba sin Sheets). */
export function filasAPodar(entradas: Array<Pick<EntradaBitacoraConFila, "cuando" | "rowIndex">>, max = MAX_ENTRADAS_BITACORA, conservar = ENTRADAS_TRAS_PODAR): number[] {
  if (entradas.length <= max) return [];
  return [...entradas].sort((a, b) => Date.parse(a.cuando) - Date.parse(b.cuando)).slice(0, entradas.length - conservar).map((e) => e.rowIndex);
}

/** Poda las entradas más antiguas cuando la pestaña crece de más. Devuelve cuántas borró. */
export async function podarBitacora(): Promise<number> {
  const sobran = filasAPodar(await leerTodas());
  if (sobran.length === 0) return 0;
  await eliminarFilas(TAB_NAME, sobran, HEADERS);
  return sobran.length;
}

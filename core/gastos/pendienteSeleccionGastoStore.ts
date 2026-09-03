import { leerFilas, agregarFila, eliminarFila } from "../google/sheetsKeyValueStore";

/**
 * Tras "▶️ Aprobar selección" (ver gasto_aprobar, gastoCallbackHandler.ts),
 * cuando lo marcado incluye una o más acciones que necesitan texto libre
 * (corregir clasificación, ajustar monto, otras acciones), este store
 * guarda la COLA ordenada de las que todavía faltan — se piden de a una
 * (nunca se intenta adivinar cuál parte de un solo mensaje responde a
 * cuál pregunta, para no arriesgar aplicar un monto donde iba una
 * corrección de empresa, o viceversa). Pedido explícito de Carlos: "activar
 * una o varias y luego aprobar para que la inteligencia del sistema
 * proceda" — esto es justamente ese "proceda": una vez aprobado, se van
 * resolviendo en orden sin que el usuario tenga que volver a tocar ningún
 * botón, y si además se marcó una decisión final (Crear/Crear y
 * conciliar/Cancelar/Adjuntar), se dispara sola al vaciarse la cola —
 * usando ya los datos corregidos/ajustados.
 */
export interface PendienteSeleccionGasto {
  chatId: number;
  propuestaId: string;
  /** Acciones que necesitan texto libre, en el orden en que se van a pedir — se va sacando la primera a medida que se responde. */
  colaAcciones: string[];
  /** Clave de gastoTeclado.ts (crear/crearconciliar/cancelar/nuevo/adjuntar_<i>) a disparar cuando colaAcciones quede vacía — undefined si no se marcó ninguna decisión final junto con las de texto. */
  decisionFinal?: string;
  creadoEn: number;
}

const TAB_NAME = "_pendientes_seleccion_gasto";
const HEADERS = ["chatId", "propuestaId", "colaAccionesJSON", "creadoEn", "decisionFinal"];
const NUM_COLS = HEADERS.length;
// 24h — mismo criterio que el resto de "pendiente_*" (ver pendienteCapturaEmpresaStore.ts).
const TTL_MS = 24 * 60 * 60 * 1000;

function filaAObjeto(valores: string[]): PendienteSeleccionGasto {
  let colaAcciones: string[] = [];
  try {
    colaAcciones = valores[2] ? JSON.parse(valores[2]) : [];
  } catch {
    colaAcciones = [];
  }
  return {
    chatId: Number(valores[0]),
    propuestaId: valores[1],
    colaAcciones,
    creadoEn: Number(valores[3]),
    decisionFinal: valores[4] || undefined,
  };
}

function objetoAFila(p: PendienteSeleccionGasto): (string | number)[] {
  return [p.chatId, p.propuestaId, JSON.stringify(p.colaAcciones), p.creadoEn, p.decisionFinal ?? ""];
}

async function leerVigentes(): Promise<{ rowIndex: number; pendiente: PendienteSeleccionGasto }[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  return filas
    .map((f) => ({ rowIndex: f.rowIndex, pendiente: filaAObjeto(f.valores) }))
    .filter((f) => ahora - f.pendiente.creadoEn <= TTL_MS);
}

export async function guardarPendienteSeleccionGasto(
  chatId: number,
  propuestaId: string,
  colaAcciones: string[],
  decisionFinal?: string
): Promise<void> {
  const vigentes = await leerVigentes();
  const previo = vigentes.find((f) => f.pendiente.chatId === chatId);
  if (previo) {
    await eliminarFila(TAB_NAME, previo.rowIndex, HEADERS);
  }
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila({ chatId, propuestaId, colaAcciones, decisionFinal, creadoEn: Date.now() }));
}

export async function consumirPendienteSeleccionGasto(chatId: number): Promise<PendienteSeleccionGasto | undefined> {
  const vigentes = await leerVigentes();
  const fila = vigentes.find((f) => f.pendiente.chatId === chatId);
  if (!fila) return undefined;
  await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
  return fila.pendiente;
}

/** Lectura sin consumir — para el resumen diario de pendientes (ver core/jobs/resumenPendientesDiario.ts). */
export async function obtenerPendienteSeleccionGastoPorChat(chatId: number): Promise<PendienteSeleccionGasto | undefined> {
  const vigentes = await leerVigentes();
  return vigentes.find((f) => f.pendiente.chatId === chatId)?.pendiente;
}

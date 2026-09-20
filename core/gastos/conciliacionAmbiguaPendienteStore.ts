import { randomUUID } from "node:crypto";
import { leerFilas, agregarFila, eliminarFila } from "../google/sheetsKeyValueStore";
import type { Empresa } from "../holded/client";
import type { MovimientoBancarioCandidato } from "../holded/write";
import { conMutex } from "../utils/asyncMutex";

/**
 * Caso real reportado por Carlos: al responder "🔗 Sí, conciliar" a la pregunta de después de crear
 * el gasto (ver preguntarSiConciliar en gastoCallbackHandler.ts), intentarConciliar volvía a buscar y
 * encontraba VARIOS movimientos parecidos — antes eso terminaba en un texto muerto ("revísalo a mano
 * en Holded"), sin ningún botón para elegir cuál, exactamente lo que Carlos pidió evitar: "preguntas,
 * pero luego no respondes... y además vuelves a preguntar". Este store guarda esos candidatos entre
 * ese mensaje y la respuesta del botón (Sheets, sobrevive un redeploy) — mismo patrón que
 * pendienteAjusteMontoGastoStore.ts/pendienteAccionGastoStore.ts, sobre sheetsKeyValueStore.ts.
 */
export interface ConciliacionAmbiguaPendiente {
  id: string;
  empresa: Empresa;
  /** Id del documento de compra en Holded al que hay que enlazar el movimiento elegido. */
  gastoId: string;
  descripcionGasto: string;
  chatId: number;
  creadoEn: number;
  /** Los movimientos parecidos entre los que Carlos tiene que elegir — ver "🔗 Conciliar con #N". */
  candidatos: MovimientoBancarioCandidato[];
  deColaCorreo?: boolean;
  /**
   * Hallazgo real de auditoría: sin este campo, un match APROXIMADO (buscarMovimientoAproximado —
   * nombre y monto parecidos, no exactos) perdía esa advertencia justo al conciliar de verdad
   * (conciliarContraMovimientoEspecifico no la conocía) — el mensaje final sonaba tan seguro como un
   * match exacto. Se guarda para poder incluir "— coincidencia APROXIMADA, confírmalo en Holded" en
   * la confirmación, igual que ya hace intentarConciliar para su propio candidato único aproximado.
   */
  esAproximado: boolean;
  /**
   * Pedido explícito de Carlos ("que la práctica te vaya dando experticia"):
   * se necesita para registrar qué descripción de movimiento eligió Carlos
   * cuando resuelve la ambigüedad (ver movimientoAmbiguoAprendidoSheet.ts) —
   * sin esto, no hay forma de saber a qué proveedor pertenece la elección.
   * Opcional porque intentarConciliar recibe proveedor como parámetro
   * opcional (no siempre disponible en los 3 caminos que lo llaman).
   */
  proveedor?: string;
  /** Mensaje concreto de Gmail que originó esta decisión. Permite que un callback tardío
   * nunca avance otro correo que haya pasado a estar activo en el mismo chat. */
  mensajeIdGmail?: string;
  /** Hilo concreto de Gmail que originó esta decisión. Las filas anteriores a esta columna
   * siguen siendo legibles, pero no prueban ownership exacto ante el watchdog. */
  threadIdGmail?: string;
  /** Solo true cuando el soporte del gasto ya fue confirmado en Holded. */
  comprobanteConfirmado: boolean;
}

const TAB_NAME = "_conciliaciones_ambiguas_pendientes";
const HEADERS = ["id", "empresa", "gastoId", "descripcionGasto", "chatId", "creadoEn", "candidatosJSON", "deColaCorreo", "esAproximado", "proveedor", "mensajeIdGmail", "comprobanteConfirmado", "threadIdGmail"];
const NUM_COLS = HEADERS.length;
const MUTEX_CONCILIACIONES_AMBIGUAS = "conciliacionAmbiguaPendienteStore:transiciones";
// Mismo TTL que conciliacionPendienteStore.ts (24h) y mismo motivo: no puede
// ser más largo que el umbral de "correo atascado" de revisarCorreoNuevo.ts,
// o una respuesta tardía podría avanzar/resolver un correo que para
// entonces ya es otro.
const TTL_MS = 24 * 60 * 60 * 1000;

/** Codec exportado para probar y auditar migraciones de filas legacy. */
export function deserializarFilaConciliacionAmbigua(valores: string[]): ConciliacionAmbiguaPendiente {
  let candidatos: MovimientoBancarioCandidato[] = [];
  try {
    candidatos = valores[6] ? JSON.parse(valores[6]) : [];
  } catch (error) {
    console.error("[conciliacionAmbiguaPendienteStore] candidatosJSON corrupto en fila, se trata como vacío:", error);
    candidatos = [];
  }
  return {
    id: valores[0],
    empresa: valores[1] as Empresa,
    gastoId: valores[2],
    descripcionGasto: valores[3],
    chatId: Number(valores[4]),
    creadoEn: Number(valores[5]),
    candidatos,
    deColaCorreo: valores[7] === "true",
    esAproximado: valores[8] === "true",
    proveedor: valores[9] || undefined,
    mensajeIdGmail: valores[10] || undefined,
    comprobanteConfirmado: valores[11] === "true",
    // Columna agregada al final: una fila legacy termina en el índice 11 y
    // conserva threadIdGmail=undefined, sin desplazar ningún campo previo.
    threadIdGmail: valores[12] || undefined,
  };
}

/** Mantiene las columnas históricas en su posición y agrega campos solo al final. */
export function serializarFilaConciliacionAmbigua(p: ConciliacionAmbiguaPendiente): (string | number)[] {
  return [
    p.id,
    p.empresa,
    p.gastoId,
    p.descripcionGasto,
    p.chatId,
    p.creadoEn,
    JSON.stringify(p.candidatos),
    p.deColaCorreo === true ? "true" : "",
    p.esAproximado ? "true" : "",
    p.proveedor ?? "",
    p.mensajeIdGmail ?? "",
    p.comprobanteConfirmado ? "true" : "",
    p.threadIdGmail ?? "",
  ];
}

async function leerVigentes(): Promise<{ rowIndex: number; pendiente: ConciliacionAmbiguaPendiente }[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  return filas
    .map((f) => ({ rowIndex: f.rowIndex, pendiente: deserializarFilaConciliacionAmbigua(f.valores) }))
    // Si pertenece a la cola, esta pregunta conserva una unidad activa y el
    // correo sigue UNREAD: no puede desaparecer solo por cumplir el TTL.
    .filter((f) => f.pendiente.deColaCorreo || ahora - f.pendiente.creadoEn <= TTL_MS);
}

export interface FilaConciliacionAmbiguaConIndice {
  rowIndex: number;
  pendiente: ConciliacionAmbiguaPendiente;
}

export interface DependenciasConsumoConciliacionAmbigua {
  leer: () => Promise<FilaConciliacionAmbiguaConIndice[]>;
  eliminar: (rowIndex: number) => Promise<void>;
}

export async function guardarConciliacionAmbiguaPendiente(
  datos: Omit<ConciliacionAmbiguaPendiente, "id" | "creadoEn">
): Promise<ConciliacionAmbiguaPendiente> {
  if (datos.deColaCorreo && (!datos.mensajeIdGmail?.trim() || !datos.threadIdGmail?.trim())) {
    throw new Error("Una conciliación ambigua de la cola requiere mensajeIdGmail y threadIdGmail exactos.");
  }
  return conMutex(MUTEX_CONCILIACIONES_AMBIGUAS, async () => {
    const pendiente: ConciliacionAmbiguaPendiente = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };
    await agregarFila(TAB_NAME, NUM_COLS, HEADERS, serializarFilaConciliacionAmbigua(pendiente));
    return pendiente;
  });
}

/**
 * Primitivo probado que reclama una conciliación ambigua una sola vez. Las
 * dependencias inyectables permiten ejercer la carrera de dos callbacks sin
 * hablar con Sheets; producción usa exactamente el mismo read→delete.
 */
export async function consumirConciliacionAmbiguaUnaVez(
  id: string,
  dependencias: DependenciasConsumoConciliacionAmbigua = {
    leer: leerVigentes,
    eliminar: (rowIndex) => eliminarFila(TAB_NAME, rowIndex, HEADERS),
  },
  claveMutex = MUTEX_CONCILIACIONES_AMBIGUAS
): Promise<ConciliacionAmbiguaPendiente | undefined> {
  return conMutex(claveMutex, async () => {
    const vigentes = await dependencias.leer();
    const fila = vigentes.find((f) => f.pendiente.id === id);
    if (!fila) return undefined;
    await dependencias.eliminar(fila.rowIndex);
    return fila.pendiente;
  });
}

/** Devuelve la pendiente y ELIMINA su fila (respondida, ya no debe quedar registro). */
export async function consumirConciliacionAmbiguaPendiente(id: string): Promise<ConciliacionAmbiguaPendiente | undefined> {
  return consumirConciliacionAmbiguaUnaVez(id);
}

/** Repone el mismo id para que los botones ya publicados sigan siendo válidos tras un fallo. */
export async function restaurarConciliacionAmbiguaPendiente(
  pendiente: ConciliacionAmbiguaPendiente
): Promise<ConciliacionAmbiguaPendiente> {
  return conMutex(MUTEX_CONCILIACIONES_AMBIGUAS, async () => {
    const existente = (await leerVigentes()).find((f) => f.pendiente.id === pendiente.id)?.pendiente;
    if (existente) return existente;
    const restaurada = { ...pendiente, creadoEn: Date.now() };
    await agregarFila(TAB_NAME, NUM_COLS, HEADERS, serializarFilaConciliacionAmbigua(restaurada));
    return restaurada;
  });
}

/** Lectura sin consumir — para el resumen diario de pendientes (ver core/jobs/resumenPendientesDiario.ts). */
export async function obtenerConciliacionesAmbiguasPendientesPorChat(chatId: number): Promise<ConciliacionAmbiguaPendiente[]> {
  return conMutex(MUTEX_CONCILIACIONES_AMBIGUAS, async () => {
    const vigentes = await leerVigentes();
    return vigentes.filter((f) => f.pendiente.chatId === chatId).map((f) => f.pendiente);
  });
}

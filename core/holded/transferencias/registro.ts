import { createHash } from "node:crypto";
import { actualizarFila, agregarFila, leerFilas } from "../../google/sheetsKeyValueStore";
import { conMutex } from "../../utils/asyncMutex";
import type { Empresa } from "../client";
import { VERSION_REGLA, type PropuestaTransferencia, type TipoOperacion } from "./deteccion";

/**
 * Registro persistente de cada operación interna detectada: sobrevive a los reinicios y es la referencia para no
 * proponer ni ejecutar dos veces la misma pareja. La clave es la pareja ORDENADA de movimientos (origen > destino).
 */
export type EstadoTransferencia =
  | "detectada" | "propuesta" | "aprobada" | "ejecutando" | "verificada"
  | "ambigua" | "fallida" | "saltada" | "descartada" | "revision_manual";

export interface RegistroTransferencia {
  clave: string;
  /** Id corto para los botones de Telegram. */
  id: string;
  empresa: Empresa;
  tipo: TipoOperacion;
  fecha: string;
  origenCuenta: string;
  origenMovimiento: string;
  origenFecha: string;
  destinoCuenta: string;
  destinoMovimiento: string;
  destinoFecha: string;
  importeOrigen: number;
  monedaOrigen: string;
  importeDestino: number;
  monedaDestino: string;
  estado: EstadoTransferencia;
  versionRegla: string;
  /** Asiento creado en Holded, en cuanto se conoce: es la pista para verificar tras un corte. */
  asientoId: string;
  chatId: number;
  messageId: number;
  detalle: string;
  creadoEn: number;
  actualizadoEn: number;
}

const TAB_NAME = "_transferencias_internas";
const HEADERS = [
  "clave", "id", "empresa", "tipo", "fecha", "origenCuenta", "origenMovimiento", "origenFecha", "destinoCuenta", "destinoMovimiento",
  "destinoFecha", "importeOrigen", "monedaOrigen", "importeDestino", "monedaDestino", "estado", "versionRegla", "asientoId", "chatId",
  "messageId", "detalle", "creadoEn", "actualizadoEn",
];
const NUM_COLS = HEADERS.length;
const MUTEX = `transferencias:${TAB_NAME}`;

export const idDeClave = (clave: string) => createHash("sha256").update(clave).digest("hex").slice(0, 12);

function desdeFila(v: string[]): RegistroTransferencia | undefined {
  if (!v[0] || !v[2] || !v[15]) return undefined;
  return {
    clave: v[0], id: v[1], empresa: v[2] as Empresa, tipo: v[3] as TipoOperacion, fecha: v[4], origenCuenta: v[5], origenMovimiento: v[6],
    origenFecha: v[7], destinoCuenta: v[8], destinoMovimiento: v[9], destinoFecha: v[10], importeOrigen: Number(v[11]), monedaOrigen: v[12],
    importeDestino: Number(v[13]), monedaDestino: v[14], estado: v[15] as EstadoTransferencia, versionRegla: v[16], asientoId: v[17] ?? "",
    chatId: Number(v[18]) || 0, messageId: Number(v[19]) || 0, detalle: v[20] ?? "", creadoEn: Number(v[21]) || 0, actualizadoEn: Number(v[22]) || 0,
  };
}

const aFila = (r: RegistroTransferencia): (string | number)[] => [
  r.clave, r.id, r.empresa, r.tipo, r.fecha, r.origenCuenta, r.origenMovimiento, r.origenFecha, r.destinoCuenta, r.destinoMovimiento, r.destinoFecha,
  r.importeOrigen, r.monedaOrigen, r.importeDestino, r.monedaDestino, r.estado, r.versionRegla, r.asientoId, r.chatId, r.messageId,
  r.detalle.slice(0, 1500), r.creadoEn, r.actualizadoEn,
];

export function registroDesdePropuesta(p: PropuestaTransferencia, ahora = Date.now()): RegistroTransferencia {
  return {
    clave: p.clave, id: idDeClave(p.clave), empresa: p.empresa, tipo: p.tipo, fecha: p.fecha,
    origenCuenta: p.origen.cuenta.id, origenMovimiento: p.origen.movimiento.id, origenFecha: p.origen.movimiento.fecha,
    destinoCuenta: p.destino.cuenta.id, destinoMovimiento: p.destino.movimiento.id, destinoFecha: p.destino.movimiento.fecha,
    importeOrigen: p.origen.movimiento.importe, monedaOrigen: p.origen.movimiento.moneda,
    importeDestino: p.destino.movimiento.importe, monedaDestino: p.destino.movimiento.moneda,
    estado: p.confianza === "bloqueada" ? "ambigua" : "detectada", versionRegla: VERSION_REGLA, asientoId: "", chatId: 0, messageId: 0,
    detalle: p.motivos.join(" · "), creadoEn: ahora, actualizadoEn: ahora,
  };
}

export async function listarRegistros(): Promise<RegistroTransferencia[]> {
  return (await leerFilas(TAB_NAME, NUM_COLS, HEADERS)).map((f) => desdeFila(f.valores)).filter((r): r is RegistroTransferencia => Boolean(r));
}

export async function obtenerRegistroPorId(id: string): Promise<RegistroTransferencia | undefined> {
  return (await listarRegistros()).find((r) => r.id === id);
}

/** Crea o actualiza por clave, bajo exclusión mutua: dos escrituras a la vez no pueden duplicar ni pisar una fila. */
export async function guardarRegistro(registro: RegistroTransferencia): Promise<void> {
  await conMutex(MUTEX, async () => {
    const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
    const actual = filas.find((f) => f.valores[0] === registro.clave);
    const fila = aFila({ ...registro, actualizadoEn: Date.now() });
    if (actual) await actualizarFila(TAB_NAME, actual.rowIndex, NUM_COLS, fila);
    else await agregarFila(TAB_NAME, NUM_COLS, HEADERS, fila);
  });
}

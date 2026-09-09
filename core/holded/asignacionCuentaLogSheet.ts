import { randomUUID } from "node:crypto";
import { leerFilas, agregarFila, eliminarFila } from "../google/sheetsKeyValueStore";
import type { Empresa } from "./client";

/**
 * Registro de qué cuenta contable se le asignó a cada gasto NUEVO al
 * crearlo por inferencia (inferirCuentaGasto) — sin instrucción explícita
 * del usuario. revisarCorreccionesCuentaContable.ts (job periódico) relee
 * cada gasto de aquí más tarde: si su cuenta actual en Holded ya no
 * coincide con lo que se asignó acá, es una señal real de que Carlos la
 * corrigió a mano — esa corrección alimenta cuentaCorregidaAprendidaSheet.ts.
 * Cada entrada se borra tras revisarse una vez (ver consumirAsignacion) — no
 * tiene sentido seguir comparando el mismo gasto una y otra vez.
 */
export interface AsignacionCuenta {
  id: string;
  gastoId: string;
  empresa: Empresa;
  proveedor: string;
  cuentaIdAsignada: string;
  creadoEn: number;
}

const TAB_NAME = "_asignaciones_cuenta_log";
const HEADERS = ["id", "gastoId", "empresa", "proveedor", "cuentaIdAsignada", "creadoEn"];
const NUM_COLS = HEADERS.length;
// Ventana de revisión: 30 días — tiempo razonable para que Carlos note y
// corrija una mala categorización a mano antes de que el job la revise.
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

function filaAObjeto(valores: string[]): AsignacionCuenta | null {
  if (!valores[0] || !valores[1]) return null;
  return {
    id: valores[0],
    gastoId: valores[1],
    empresa: valores[2] as Empresa,
    proveedor: valores[3] ?? "",
    cuentaIdAsignada: valores[4] ?? "",
    creadoEn: Number(valores[5]) || 0,
  };
}

function objetoAFila(a: AsignacionCuenta): (string | number)[] {
  return [a.id, a.gastoId, a.empresa, a.proveedor, a.cuentaIdAsignada, a.creadoEn];
}

/** Registra que este gasto se creó con esta cuenta, por inferencia (nunca cuando el usuario la fuerza explícita). */
export async function registrarAsignacionCuenta(datos: Omit<AsignacionCuenta, "id" | "creadoEn">): Promise<void> {
  if (!datos.gastoId || !datos.cuentaIdAsignada) return;
  const asignacion: AsignacionCuenta = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila(asignacion));
}

/**
 * Todas las asignaciones dentro de la ventana de revisión, listas para que
 * el job las compare — NUNCA las borra (eso lo hace consumirAsignacion,
 * después de revisar cada una individualmente).
 */
export async function obtenerAsignacionesPendientesDeRevisar(): Promise<AsignacionCuenta[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  return filas
    .map((f) => filaAObjeto(f.valores))
    .filter((a): a is AsignacionCuenta => a !== null && ahora - a.creadoEn <= TTL_MS);
}

/** Marca una asignación como ya revisada (la elimina — no tiene sentido revisar el mismo gasto dos veces). */
export async function consumirAsignacionCuenta(id: string): Promise<void> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const fila = filas.find((f) => f.valores[0] === id);
  if (!fila) return;
  await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
}

/** Purga asignaciones vencidas (más de 30 días, nunca revisadas por algún motivo) — mantenimiento, no crítico. */
export async function purgarAsignacionesVencidas(): Promise<void> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  const vencidas = filas.filter((f) => {
    const a = filaAObjeto(f.valores);
    return !a || ahora - a.creadoEn > TTL_MS;
  });
  // De atrás hacia adelante — eliminarFila desplaza filas hacia arriba, borrar de la última a la primera evita invalidar los índices ya calculados.
  vencidas.sort((a, b) => b.rowIndex - a.rowIndex);
  for (const fila of vencidas) {
    await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
  }
}

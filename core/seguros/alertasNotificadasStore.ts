import { leerFilas, agregarFila, actualizarFila, eliminarFilas, type FilaCruda } from "../google/sheetsKeyValueStore";

/**
 * Registro de qué alertas de seguros (core/seguros/alertas.ts) ya se
 * avisaron por Telegram — mismo propósito que
 * core/jobs/anotacionesCashflowNotificadasStore.ts (dedup por id+versión,
 * para no reenviar lo mismo todos los días mientras nadie lo resuelva),
 * pero construido sobre sheetsKeyValueStore.ts en vez de un cliente de
 * Sheets propio — ese store es anterior al direccionamiento explícito de
 * "nunca un cliente de Sheets propio" (CLAUDE.md), este ya nace siguiéndolo.
 *
 * `id` es compuesto (`${polizaId}:renovacion` o `${polizaId}:pago`) porque
 * una misma póliza puede tener ambas alertas activas a la vez y son
 * conceptualmente distintas — dedup independiente para cada una.
 *
 * `version` es lo que decide si hay que re-avisar:
 * - alertas de renovación: la propia `fechaVencimiento` — solo cambia si la
 *   póliza se renueva de verdad (fecha nueva) o si Wobi la actualiza.
 * - alertas de pago: un hash de `estadoPago + prima + notas` — a diferencia
 *   de la fecha de vencimiento, la historia de un pago pendiente evoluciona
 *   en texto libre (ver notas de woba_showroom_complemento_2026_2027, que
 *   pasó de "sin sello de pagado" a "el banco lo devolvió, aviso directo de
 *   Allianz, plazo legal" en la misma sesión) — dedup solo por estadoPago
 *   habría dejado ese cambio real sin avisar de nuevo.
 */
const TAB_NAME = "_alertas_seguros_notificadas";
const HEADERS = ["id", "version", "notificadoEn"];
const NUM_COLS = HEADERS.length;

interface AlertaNotificada extends FilaCruda {
  id: string;
  version: string;
}

function filaAAlerta(fila: FilaCruda): AlertaNotificada {
  const [id, version] = fila.valores;
  return { ...fila, id, version };
}

/** id -> última versión notificada. */
export async function obtenerAlertasSegurosYaNotificadas(): Promise<Map<string, string>> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  return new Map(filas.map(filaAAlerta).map((a) => [a.id, a.version]));
}

/**
 * Upsert real: si el id ya tiene fila (una versión anterior ya notificada),
 * la actualiza en el mismo lugar — nunca agrega una fila nueva por encima.
 * Sin esto, cada re-aviso (ej. el pago que pasó de "pendiente" a "devuelto
 * por el banco") iría acumulando una fila vieja por versión, nunca
 * limpiada por purgarAlertasSegurosNoActivas (el id sigue activo, solo
 * cambió su versión).
 */
export async function marcarAlertaSeguroNotificada(id: string, version: string): Promise<void> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const existente = filas.map(filaAAlerta).find((a) => a.id === id);
  const valores = [id, version, new Date().toISOString()];
  if (existente) {
    await actualizarFila(TAB_NAME, existente.rowIndex, NUM_COLS, valores);
  } else {
    await agregarFila(TAB_NAME, NUM_COLS, HEADERS, valores);
  }
}

/** Borra del registro cualquier id que ya no esté activo (la alerta dejó de aplicar) — corre siempre, no solo cuando hay algo nuevo que avisar. */
export async function purgarAlertasSegurosNoActivas(idsActivos: Set<string>): Promise<number> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const inactivas = filas.map(filaAAlerta).filter((a) => !idsActivos.has(a.id));
  if (inactivas.length === 0) return 0;
  await eliminarFilas(TAB_NAME, inactivas.map((a) => a.rowIndex), HEADERS);
  return inactivas.length;
}

import { agregarFila, leerFilas } from "../google/sheetsKeyValueStore";
import { conMutex } from "../utils/asyncMutex";

/**
 * Registro de qué cargos ya se pidieron y a quién, para no repetir el mismo reclamo a la semana siguiente. Un cargo
 * pedido hace menos de DIAS_ENTRE_RECORDATORIOS días no se vuelve a incluir; pasado ese tiempo sí, marcado como
 * recordatorio. El identificador es el ID de la operación en el extracto de Revolut (estable entre extractos solapados).
 * Una fila por correo enviado (con la lista de IDs), para no gastar una escritura de Sheets por cada cargo.
 */
const TAB_NAME = "_soportes_solicitados";
const HEADERS = ["campana", "empresa", "titular", "solicitadoEn", "idsOperacion"];
const NUM_COLS = HEADERS.length;
const MUTEX = `soportes-solicitados:${TAB_NAME}`;
const MAX_CARACTERES_CELDA = 45_000;

export const DIAS_ENTRE_RECORDATORIOS = 7;

export interface Solicitud { titular: string; solicitadoEn: number }

/** ID de operación → última solicitud (de esa empresa). */
export async function leerSolicitudes(empresa: string): Promise<Map<string, Solicitud>> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const mapa = new Map<string, Solicitud>();
  for (const f of filas) {
    if (f.valores[1] !== empresa) continue;
    const solicitadoEn = Number(f.valores[3]) || 0;
    let ids: unknown;
    try { ids = JSON.parse(f.valores[4]); } catch (error) {
      console.error("[soportes] Fila de solicitudes ilegible, se ignora:", error instanceof Error ? error.message : error);
      continue;
    }
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      const previa = mapa.get(String(id));
      if (!previa || solicitadoEn > previa.solicitadoEn) mapa.set(String(id), { titular: f.valores[2], solicitadoEn });
    }
  }
  return mapa;
}

export function pedidoRecientemente(s: Solicitud | undefined, ahora: number): boolean {
  return !!s && ahora - s.solicitadoEn < DIAS_ENTRE_RECORDATORIOS * 86_400_000;
}

export async function registrarSolicitud(empresa: string, titular: string, campana: string, idsOperacion: string[], ahora: number): Promise<void> {
  const ids = JSON.stringify(idsOperacion);
  if (ids.length > MAX_CARACTERES_CELDA) throw new Error("Demasiadas operaciones en un solo correo para registrarlas en una celda.");
  await conMutex(MUTEX, () => agregarFila(TAB_NAME, NUM_COLS, HEADERS, [campana, empresa, titular, ahora, ids]).then(() => undefined));
}

/** Quién ha recibido alguna solicitud de soportes, por empresa (para el aviso de formato): una entrada por titular y empresa, la más reciente. */
export async function leerSolicitantes(): Promise<Array<{ empresa: string; titular: string; solicitadoEn: number }>> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const mapa = new Map<string, { empresa: string; titular: string; solicitadoEn: number }>();
  for (const f of filas) {
    const empresa = f.valores[1], titular = f.valores[2], solicitadoEn = Number(f.valores[3]) || 0;
    if (!empresa || !titular) continue;
    const clave = `${empresa}|${titular}`;
    const previa = mapa.get(clave);
    if (!previa || solicitadoEn > previa.solicitadoEn) mapa.set(clave, { empresa, titular, solicitadoEn });
  }
  return [...mapa.values()];
}

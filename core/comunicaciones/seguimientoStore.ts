import { actualizarFila, agregarFila, leerFilas } from "../google/sheetsKeyValueStore";
import { conMutex } from "../utils/asyncMutex";

/** Qué correos entrantes de una comunicación ya se contaron en un resumen (para avisar solo de lo nuevo) y si ya se avisó de quienes no contestan. */
const TAB = "_comunicaciones_seguimiento";
const HEADERS = ["comunicacion", "vistos", "avisoSinRespuesta", "actualizadoEn"];
const MUTEX = `comunicaciones-seguimiento:${TAB}`;
const MAX_CARACTERES_CELDA = 40_000;

export interface EstadoSeguimiento { vistos: Set<string>; avisoSinRespuesta: boolean }

export async function leerEstadoSeguimiento(id: string): Promise<EstadoSeguimiento> {
  const fila = (await leerFilas(TAB, HEADERS.length, HEADERS)).find((f) => f.valores[0] === id);
  let vistos: string[] = [];
  try { const j = fila ? JSON.parse(fila.valores[1] || "[]") : []; if (Array.isArray(j)) vistos = j.map(String); } catch { /* fila ilegible: se cuenta todo como nuevo */ }
  return { vistos: new Set(vistos), avisoSinRespuesta: fila?.valores[2] === "true" };
}

export async function guardarEstadoSeguimiento(id: string, estado: EstadoSeguimiento, ahora = Date.now()): Promise<void> {
  const vistos = JSON.stringify([...estado.vistos]);
  if (vistos.length > MAX_CARACTERES_CELDA) throw new Error("Demasiados correos vistos para guardar el seguimiento de una comunicación.");
  await conMutex(MUTEX, async () => {
    const fila = (await leerFilas(TAB, HEADERS.length, HEADERS)).find((f) => f.valores[0] === id);
    const valores = [id, vistos, estado.avisoSinRespuesta ? "true" : "false", ahora];
    if (fila) await actualizarFila(TAB, fila.rowIndex, HEADERS.length, valores);
    else await agregarFila(TAB, HEADERS.length, HEADERS, valores);
  });
}

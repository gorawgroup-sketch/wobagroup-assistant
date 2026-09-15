import { leerFilas, agregarFila, actualizarFila, eliminarFila } from "../google/sheetsKeyValueStore";

/**
 * Pedido explícito de Carlos: poder decirle a Wobi, directamente desde el Diagnóstico Diario del
 * chat del front ("🔍 Preguntarle a Wobi" en cada tarjeta de recomendación), que una recomendación
 * ya la revisó y que no amerita acción — "que yo le pueda dar la orden... y el sistema haga todo lo
 * necesario automáticamente" — sin que vuelva a aparecer como incidencia el resto del día. Las
 * recomendaciones de controlDiario.ts son por CATEGORÍA (ej. "conciliaciones-holded-inciertas"), no
 * por instancia puntual — un descarte silencia esa categoría por un tiempo acotado, nunca para
 * siempre: si el problema real cambia de magnitud o reaparece al día siguiente, vuelve a mostrarse.
 */
export interface DescarteRecomendacionControlDiario {
  id: string;
  motivo?: string;
  descartadoEn: number;
  expiraEn: number;
}

const TAB_NAME = "_control_diario_descartes";
const HEADERS = ["id", "motivo", "descartadoEn", "expiraEn"];
const NUM_COLS = HEADERS.length;
// 24h — mismo criterio que el resto de "pendiente_*"/descartes de este proyecto: cubre "no me
// vuelvas a avisar de esto HOY", no un silencio indefinido de un problema real que podría empeorar.
const DURACION_DEFECTO_MS = 24 * 60 * 60 * 1000;

function filaAObjeto(valores: string[]): DescarteRecomendacionControlDiario | undefined {
  const id = valores[0];
  const descartadoEn = Number(valores[2]) || 0;
  const expiraEn = Number(valores[3]) || 0;
  if (!id || !descartadoEn || !expiraEn) return undefined;
  return { id, motivo: valores[1] || undefined, descartadoEn, expiraEn };
}

function objetoAFila(d: DescarteRecomendacionControlDiario): (string | number)[] {
  return [d.id, d.motivo ?? "", d.descartadoEn, d.expiraEn];
}

async function leerVigentes(): Promise<{ rowIndex: number; descarte: DescarteRecomendacionControlDiario }[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  return filas
    .map((f) => ({ rowIndex: f.rowIndex, descarte: filaAObjeto(f.valores) }))
    .filter((f): f is { rowIndex: number; descarte: DescarteRecomendacionControlDiario } => Boolean(f.descarte) && f.descarte!.expiraEn > ahora);
}

/** Registra (o renueva) el descarte de una recomendación por `duracionMs` (24h por defecto). */
export async function descartarRecomendacionControlDiario(
  id: string,
  motivo?: string,
  duracionMs: number = DURACION_DEFECTO_MS
): Promise<void> {
  const ahora = Date.now();
  const nuevo: DescarteRecomendacionControlDiario = { id, motivo, descartadoEn: ahora, expiraEn: ahora + duracionMs };

  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const existente = filas.find((f) => f.valores[0] === id);
  if (existente) {
    await actualizarFila(TAB_NAME, existente.rowIndex, NUM_COLS, objetoAFila(nuevo));
  } else {
    await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila(nuevo));
  }
}

/** IDs de recomendación actualmente descartados (vigentes) — para que controlDiario.ts los filtre. */
export async function obtenerRecomendacionesDescartadas(): Promise<Set<string>> {
  const vigentes = await leerVigentes();
  // Purga oportunista de expirados, sin bloquear la lectura por ello.
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  const expiradas = filas.filter((f) => {
    const d = filaAObjeto(f.valores);
    return d && d.expiraEn <= ahora;
  });
  expiradas.sort((a, b) => b.rowIndex - a.rowIndex);
  for (const fila of expiradas) {
    await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS).catch((error) =>
      console.error("[controlDiarioDescartesStore] Error purgando un descarte vencido (no crítico):", error)
    );
  }
  return new Set(vigentes.map((v) => v.descarte.id));
}

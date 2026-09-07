import { leerFilas, agregarFila, actualizarFila } from "../google/sheetsKeyValueStore";

/**
 * Un arreglo de código propuesto por la autorrevisión nocturna, pendiente
 * del tap de aprobación de Carlos en Telegram — desplegar (fusionar el PR a
 * main) o descartar (cerrar el PR sin fusionar). Nunca se despliega nada
 * sin ese tap (ver autorrevisionCodigo.ts / autorrepairCallbackHandler.ts).
 *
 * "desplegando"/"descartando" son estados de tránsito, no solo
 * "pendiente"→terminal directo — hallazgo real de auditoría: la llamada a
 * GitHub (fusionar o cerrar el PR) puede fallar DESPUÉS de reclamar la
 * acción, y sin este paso intermedio el registro quedaba marcado
 * "desplegado" para siempre aunque el merge real hubiera fallado, sin
 * ninguna forma de reintentar desde Telegram. Con el estado de tránsito,
 * un fallo puede revertir a "pendiente" (ver avanzarEstadoAutorrepair) y el
 * mismo botón vuelve a funcionar.
 */
export type EstadoAutorrepair = "pendiente" | "desplegando" | "desplegado" | "descartando" | "descartado";
const ESTADOS_VALIDOS: EstadoAutorrepair[] = ["pendiente", "desplegando", "desplegado", "descartando", "descartado"];

export interface AutorrepairPendiente {
  numeroPR: number;
  rama: string;
  ruta: string;
  resumen: string;
  urlPR: string;
  chatId: number;
  estado: EstadoAutorrepair;
  creadoEn: number;
}

const TAB_NAME = "_autorrepair_pendientes";
const HEADERS = ["numeroPR", "rama", "ruta", "resumen", "urlPR", "chatId", "estado", "creadoEn"];
const NUM_COLS = HEADERS.length;

function filaAObjeto(valores: string[]): AutorrepairPendiente {
  const estadoCrudo = valores[6];
  return {
    numeroPR: Number(valores[0]) || 0,
    rama: valores[1] || "",
    ruta: valores[2] || "",
    resumen: valores[3] || "",
    urlPR: valores[4] || "",
    chatId: Number(valores[5]) || 0,
    estado: (ESTADOS_VALIDOS as string[]).includes(estadoCrudo) ? (estadoCrudo as EstadoAutorrepair) : "pendiente",
    creadoEn: Number(valores[7]) || 0,
  };
}

function objetoAFila(p: AutorrepairPendiente): (string | number)[] {
  return [p.numeroPR, p.rama, p.ruta, p.resumen, p.urlPR, p.chatId, p.estado, p.creadoEn];
}

async function leerTodos(): Promise<{ rowIndex: number; registro: AutorrepairPendiente }[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  return filas.map((f) => ({ rowIndex: f.rowIndex, registro: filaAObjeto(f.valores) }));
}

export async function crearPendienteAutorrepair(datos: {
  numeroPR: number;
  rama: string;
  ruta: string;
  resumen: string;
  urlPR: string;
  chatId: number;
}): Promise<void> {
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila({ ...datos, estado: "pendiente", creadoEn: Date.now() }));
}

/** Para el resumen diario de pendientes — ver resumenPendientesDiario.ts. */
export async function obtenerPendientesAutorrepairPorChat(chatId: number): Promise<AutorrepairPendiente[]> {
  const todos = await leerTodos();
  return todos.filter((f) => f.registro.chatId === chatId && f.registro.estado === "pendiente").map((f) => f.registro);
}

/**
 * Comparar-y-cambiar: transiciona el registro de "desde" a "hasta", o devuelve undefined si no había
 * ningún registro para este PR o si su estado actual no era "desde" — mismo patrón que
 * resolverHiloAutorespuesta en hiloAutorespuestaStore.ts, para que un doble-tap sobre el mismo botón
 * (o dos entregas del mismo callback_query de Telegram) nunca dispare la acción real dos veces.
 */
export async function avanzarEstadoAutorrepair(
  numeroPR: number,
  desde: EstadoAutorrepair,
  hasta: EstadoAutorrepair
): Promise<AutorrepairPendiente | undefined> {
  const todos = await leerTodos();
  const fila = todos.find((f) => f.registro.numeroPR === numeroPR);
  if (!fila || fila.registro.estado !== desde) return undefined;

  const actualizado: AutorrepairPendiente = { ...fila.registro, estado: hasta };
  await actualizarFila(TAB_NAME, fila.rowIndex, NUM_COLS, objetoAFila(actualizado));
  return actualizado;
}

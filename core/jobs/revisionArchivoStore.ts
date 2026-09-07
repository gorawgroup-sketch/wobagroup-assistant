import { leerFilas, agregarFila, actualizarFila } from "../google/sheetsKeyValueStore";

/**
 * Cuándo se revisó por última vez cada archivo en la autorrevisión nocturna
 * de código (ver autorrevisionCodigo.ts) — permite rotar por el repo
 * completo unos pocos archivos por noche (nunca revisar todo de una, pedido
 * explícito de Carlos de mantener el costo controlado) sin repetir siempre
 * los mismos.
 */
interface RevisionArchivo {
  ruta: string;
  ultimaRevision: number;
}

const TAB_NAME = "_revision_archivos_codigo";
const HEADERS = ["ruta", "ultimaRevision"];
const NUM_COLS = HEADERS.length;

function filaAObjeto(valores: string[]): RevisionArchivo {
  return { ruta: valores[0] || "", ultimaRevision: Number(valores[1]) || 0 };
}

function objetoAFila(r: RevisionArchivo): (string | number)[] {
  return [r.ruta, r.ultimaRevision];
}

async function leerTodos(): Promise<{ rowIndex: number; registro: RevisionArchivo }[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  return filas.map((f) => ({ rowIndex: f.rowIndex, registro: filaAObjeto(f.valores) }));
}

/** ruta -> timestamp de la última revisión (una ruta nunca vista simplemente no aparece, se trata como 0). */
export async function obtenerMapaUltimaRevision(): Promise<Map<string, number>> {
  const todos = await leerTodos();
  return new Map(todos.map((f) => [f.registro.ruta, f.registro.ultimaRevision]));
}

export async function marcarArchivoRevisado(ruta: string): Promise<void> {
  const todos = await leerTodos();
  const fila = todos.find((f) => f.registro.ruta === ruta);
  const actualizado: RevisionArchivo = { ruta, ultimaRevision: Date.now() };

  if (fila) {
    await actualizarFila(TAB_NAME, fila.rowIndex, NUM_COLS, objetoAFila(actualizado));
  } else {
    await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila(actualizado));
  }
}

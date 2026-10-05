import { leerFilas, agregarFila, actualizarFila, eliminarFilas, type FilaCruda } from "../../google/sheetsKeyValueStore";

/**
 * Memoria del vigilante de seguros: qué ya avisó y qué quedó a medias. Pestaña propia (`_seguros_vigilante`) y NO la
 * de alertas (`_alertas_seguros_notificadas`): el job de alertas purga cada día todo id que no sea suyo, así que
 * compartir pestaña borraría esta memoria a diario.
 *
 * Claves en uso (id → version):
 *  - `correo:<id de Gmail>` → "visto"                       correo ya avisado
 *  - `__inicio__:correo` → fecha                              primera revisión hecha (no se avisa lo anterior)
 *  - `cargo:<empresa>:<contraparte>[:<mes>]` → "avisado"      cargo a una aseguradora que no encaja
 *  - `huerfano:<id del apunte>` → "avisado"                   cargo que el saldo no refleja
 *  - `transito:<pólizas>:<id del apunte>` → estado            cargo visto pero aún no asentado
 *  - `devolucion:<póliza>:<id del apunte>` → "avisado"        posible devolución
 *  - `fallo:<fuente>` → fecha del primer fallo seguido        lectura que lleva días fallando
 *  - `pendiente_envio` → JSON del informe                     informe que no se pudo entregar (se reintenta)
 */
const TAB_NAME = "_seguros_vigilante";
const HEADERS = ["id", "version", "actualizadoEn"];
const NUM_COLS = HEADERS.length;

export interface EntradaEstado {
  id: string;
  version: string;
  actualizadoEn: string;
  rowIndex: number;
}

function filaAEntrada(fila: FilaCruda): EntradaEstado {
  const [id, version, actualizadoEn] = fila.valores;
  return { id: id ?? "", version: version ?? "", actualizadoEn: actualizadoEn ?? "", rowIndex: fila.rowIndex };
}

export async function leerEstadoVigilante(): Promise<Map<string, EntradaEstado>> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  return new Map(filas.map(filaAEntrada).filter((e) => e.id).map((e) => [e.id, e]));
}

/** Guarda (o actualiza en su sitio) varios pares id→versión leyendo la pestaña una sola vez. */
export async function guardarEstadoVigilante(pares: Array<{ id: string; version: string }>): Promise<void> {
  if (pares.length === 0) return;
  const actual = await leerEstadoVigilante();
  const ahora = new Date().toISOString();
  for (const { id, version } of pares) {
    const previo = actual.get(id);
    if (previo && previo.version === version) continue;
    if (previo) await actualizarFila(TAB_NAME, previo.rowIndex, NUM_COLS, [id, version, ahora]);
    else await agregarFila(TAB_NAME, NUM_COLS, HEADERS, [id, version, ahora]);
  }
}

/** Borra las entradas que cumplan el criterio (p. ej. correos vistos hace más de 60 días). */
export async function purgarEstadoVigilante(debeBorrarse: (entrada: EntradaEstado) => boolean): Promise<number> {
  const actual = await leerEstadoVigilante();
  const aBorrar = [...actual.values()].filter(debeBorrarse);
  if (aBorrar.length === 0) return 0;
  await eliminarFilas(TAB_NAME, aBorrar.map((e) => e.rowIndex), HEADERS);
  return aBorrar.length;
}

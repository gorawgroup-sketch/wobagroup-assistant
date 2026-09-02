import { randomUUID } from "node:crypto";
import { leerFilas, agregarFila } from "../google/sheetsKeyValueStore";

/**
 * Pedido explícito de Carlos, tras un caso real (un documento EAD de
 * exportación con la propuesta correcta, pero sin forma de "enseñarle" a
 * Wobi que la próxima vez no hace falta preguntar): "es importante que
 * este análisis me dé la alternativa de... decirle que guarde este
 * conocimiento... no hay forma de enseñarle una regla para el futuro".
 *
 * A diferencia de una corrección genérica (core/knowledge/correctionsStore.ts
 * — texto libre, solo se re-lee si Claude decide consultar la base de
 * conocimiento ESE turno, nunca garantizado), esto es una regla
 * DETERMINISTA: clasificarDocumento (classifyFile.ts) la consulta primero,
 * por código, ANTES de gastar una llamada a Claude — si el nombre de
 * archivo o el caption contienen el criterio guardado, la clasificación
 * sale directo, sin preguntar de nuevo. Mismo patrón que
 * proveedorAliasSheet.ts para gastos (fijarAliasProveedor.ts).
 */
export interface ReglaClasificacion {
  id: string;
  empresa: string;
  criterio: string;
  tipoDocumento: string;
  carpetaDestino: string;
  creadoEn: string;
}

const TAB_NAME = "_reglas_clasificacion_documentos";
const HEADERS = ["id", "empresa", "criterio", "tipoDocumento", "carpetaDestino", "creadoEn"];
const NUM_COLS = HEADERS.length;

function filaAObjeto(valores: string[]): ReglaClasificacion {
  return {
    id: valores[0],
    empresa: valores[1],
    criterio: valores[2],
    tipoDocumento: valores[3],
    carpetaDestino: valores[4],
    creadoEn: valores[5],
  };
}

function objetoAFila(r: ReglaClasificacion): (string | number)[] {
  return [r.id, r.empresa, r.criterio, r.tipoDocumento, r.carpetaDestino, r.creadoEn];
}

export async function registrarReglaClasificacion(
  datos: Omit<ReglaClasificacion, "id" | "creadoEn">
): Promise<ReglaClasificacion> {
  const regla: ReglaClasificacion = { ...datos, id: randomUUID().slice(0, 8), creadoEn: new Date().toISOString() };
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila(regla));
  return regla;
}

/**
 * Busca la primera regla cuyo criterio aparezca (sin distinguir mayúsculas)
 * en el nombre de archivo o el caption del documento entrante. No filtra
 * por empresa de antemano — la empresa es parte de lo que la regla ya
 * decide, no un dato que se tenga todavía en este punto.
 */
export async function buscarReglaClasificacion(
  nombreArchivo: string,
  caption: string | undefined
): Promise<ReglaClasificacion | undefined> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const reglas = filas.map((f) => filaAObjeto(f.valores)).filter((r) => r.id);
  const textoCombinado = `${nombreArchivo} ${caption ?? ""}`.toLowerCase();

  return reglas.find((r) => r.criterio && textoCombinado.includes(r.criterio.toLowerCase()));
}

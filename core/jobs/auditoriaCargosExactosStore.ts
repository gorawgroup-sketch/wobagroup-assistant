import { agregarFila, leerFilas } from "../google/sheetsKeyValueStore";

/** Registro de qué parejas compra↔cargo ya se avisaron (una sola vez por pareja). Pestaña oculta de Sheets con el almacén común. */
const TAB = "_auditoria_cargos_exactos";
const HEADERS = ["clave", "avisadoEn"];

export async function clavesYaAvisadas(): Promise<Set<string>> {
  return new Set((await leerFilas(TAB, HEADERS.length, HEADERS)).map((f) => f.valores[0]).filter(Boolean));
}

export async function marcarClavesAvisadas(claves: string[]): Promise<void> {
  const ahora = new Date().toISOString();
  for (const c of claves) await agregarFila(TAB, HEADERS.length, HEADERS, [c, ahora]);
}

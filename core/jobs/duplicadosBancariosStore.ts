import { agregarFila, leerFilas } from "../google/sheetsKeyValueStore";

/** Registro de qué lotes de copias bancarias ya se avisaron (una sola vez por lote). Pestaña oculta de Sheets con el almacén común. */
const TAB = "_duplicados_bancarios_avisados";
const HEADERS = ["clave", "avisadoEn"];

export async function lotesYaAvisados(): Promise<Set<string>> {
  return new Set((await leerFilas(TAB, HEADERS.length, HEADERS)).map((f) => f.valores[0]).filter(Boolean));
}

export async function marcarLotesAvisados(claves: string[]): Promise<void> {
  const ahora = new Date().toISOString();
  for (const c of claves) await agregarFila(TAB, HEADERS.length, HEADERS, [c, ahora]);
}

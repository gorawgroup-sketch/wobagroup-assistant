import { agregarFila, leerFilas } from "../google/sheetsKeyValueStore";

/** Qué propuestas de pagos a colaboradores ya se mandaron y cuándo (core/holded/pagosColaboradores.ts): no se repiten cada día, solo pasada la ventana de espera. */
const TAB = "_pagos_colaboradores_propuestos";
const HEADERS = ["clave", "propuestoEn"];
/** Última vez que se propuso cada clave (la ventana de espera de cada tipo la decide core/holded/pagosColaboradores.ts). */
export async function propuestasRecientes(): Promise<Map<string, number>> {
  const ultimas = new Map<string, number>();
  for (const f of await leerFilas(TAB, HEADERS.length, HEADERS)) {
    const t = Date.parse(f.valores[1]);
    if (f.valores[0] && Number.isFinite(t) && t > (ultimas.get(f.valores[0]) ?? 0)) ultimas.set(f.valores[0], t);
  }
  return ultimas;
}

export async function marcarPropuestas(claves: string[]): Promise<void> {
  const ahora = new Date().toISOString();
  for (const c of claves) await agregarFila(TAB, HEADERS.length, HEADERS, [c, ahora]);
}

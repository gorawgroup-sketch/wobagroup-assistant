/**
 * Reparto óptimo de cargos bancarios entre recibos que compiten por ellos (caso hotel MOME, 2026-10-05: dos recibos del
 * mismo hotel —446.403 y 364.546 COP— y dos cargos «The Cut Hotel» —120,09 € y 112,87 USD—; cada cargo solo cuadra por
 * importe×tasa con UNO de los recibos, y el descriptor bancario es el mismo). Cada recibo se buscaba por separado, así
 * que bastaba una desviación aceptable (≤ 3 %) para ofrecer un cargo que en realidad encaja mejor con otro recibo.
 *
 * Es una función pura: recibe una matriz de costes (desviación relativa; `undefined` = el cargo no es admisible para
 * ese recibo) y decide si un cargo debe ir a otro recibo. Es CONSERVADORA: solo desplaza un cargo si el reparto óptimo
 * global lo asigna a otro recibo y la alternativa de dárselo a este es peor por más que `MARGEN_DESPLAZAMIENTO`.
 * Con empate, o sin competidor admisible, el cargo se conserva.
 */
export type MatrizCostes = Array<Array<number | undefined>>;

/** Diferencia mínima de desviación relativa (1 punto: el margen del banco varía entre 1 % y 3 %) para considerar que otro recibo encaja claramente mejor. */
export const MARGEN_DESPLAZAMIENTO = 0.01;
/** Por encima de este tamaño no se calcula (el reparto es exponencial); se conserva el comportamiento anterior. */
export const MAX_RECIBOS_REPARTO = 8;
export const MAX_CARGOS_REPARTO = 10;

interface Solucion { coincidencias: number; coste: number }

const mejor = (a: Solucion, b: Solucion): Solucion =>
  a.coincidencias !== b.coincidencias ? (a.coincidencias > b.coincidencias ? a : b) : a.coste <= b.coste ? a : b;

/** Máximo de coincidencias y, a igualdad, menor coste total. `vetado`: columna que los competidores (filas > 0) no pueden usar. */
function resolver(matriz: MatrizCostes, vetado?: number): Solucion {
  const nCargos = matriz[0]?.length ?? 0;
  const memo = new Map<string, Solucion>();
  const ir = (recibo: number, usados: number): Solucion => {
    if (recibo >= matriz.length) return { coincidencias: 0, coste: 0 };
    const clave = `${recibo}:${usados}`;
    const guardada = memo.get(clave);
    if (guardada) return guardada;
    let resultado: Solucion = ir(recibo + 1, usados); // este recibo queda sin asignar
    for (let c = 0; c < nCargos; c++) {
      if (usados & (1 << c)) continue;
      if (recibo > 0 && c === vetado) continue;
      const coste = matriz[recibo][c];
      if (coste === undefined) continue;
      const resto = ir(recibo + 1, usados | (1 << c));
      resultado = mejor(resultado, { coincidencias: resto.coincidencias + 1, coste: resto.coste + coste });
    }
    memo.set(clave, resultado);
    return resultado;
  };
  return ir(0, 0);
}

/**
 * ¿Debe el cargo `cargo` ir a OTRO recibo en lugar del recibo 0 (el que se está procesando)?
 * `matriz[0]` son los costes del recibo actual; las demás filas, los de los recibos competidores (las columnas pueden
 * incluir cargos que solo los competidores ven: sus alternativas reales).
 *
 * Un cargo se desplaza solo si OTRO recibo lo NECESITA: vetárselo a los competidores empeora el reparto global (menos
 * coincidencias o más desviación total por más del margen). Que el cargo sea peor para este recibo que otra alternativa
 * suya no basta: si nadie más lo reclama, se conserva.
 */
export function cargoCorrespondeMejorAOtroRecibo(matriz: MatrizCostes, cargo: number): boolean {
  if (matriz.length < 2) return false;
  if (matriz.length > MAX_RECIBOS_REPARTO || (matriz[0]?.length ?? 0) > MAX_CARGOS_REPARTO) return false;
  if (matriz[0][cargo] === undefined) return false;
  // Solo importa si algún competidor admite este cargo.
  if (!matriz.slice(1).some((fila) => fila[cargo] !== undefined)) return false;
  const optimo = resolver(matriz);
  const sinCompetencia = resolver(matriz, cargo);
  if (sinCompetencia.coincidencias < optimo.coincidencias) return true;
  return sinCompetencia.coste - optimo.coste > MARGEN_DESPLAZAMIENTO;
}

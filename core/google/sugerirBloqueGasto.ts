import type { DetalleCategoria, DetalleRegistro } from "./cashflowSheet";
import type { BloqueEscritura } from "./cashflowWrite";

export interface CategoriaSugerida {
  categoria: DetalleCategoria;
  /** null = esta categoría todavía no es escribible automáticamente (ver cashflowWrite.ts). */
  bloque: BloqueEscritura | null;
  etiqueta: string;
  score: number;
}

// IMPUESTOS_POR_PAGAR y APLAZAMIENTO_IMPUESTOS mapean a bloque: null a
// propósito — ambas viven ahora en columnas apiladas compartidas con Pagos
// Proyectos (columna N, ver parsearSeccionesColumnaN en cashflowSheet.ts),
// y todavía no tienen su propio escritor automático (necesita manejar el
// mismo patrón de "encontrar hueco sin invadir la sección de al lado" que
// ya usa registrarPendienteEnSheet para X:Z, pero con columnas y esquema
// distintos) — se construye cuando aparezca un caso real que lo necesite.
const CATEGORIA_A_BLOQUE: Record<DetalleCategoria, { bloque: BloqueEscritura | null; etiqueta: string }> = {
  INGRESOS: { bloque: "ingresos", etiqueta: "Ingresos" },
  PAGOS_PROYECTOS: { bloque: "pagos_proyectos", etiqueta: "Pagos Proyectos" },
  PAGOS_EXTRAS: { bloque: "pagos_extras", etiqueta: "Pagos Extras" },
  GASTOS_FIJOS: { bloque: "gastos_fijos", etiqueta: "Gastos Fijos" },
  IMPUESTOS_POR_PAGAR: { bloque: null, etiqueta: "Impuestos por Pagar" },
  APLAZAMIENTO_IMPUESTOS: { bloque: null, etiqueta: "Aplazamiento Impuestos por Pagar" },
  PAGOS_PENDIENTES_ALBERTO: { bloque: "pagos_pendientes_alberto", etiqueta: "Pagos Pendientes Alberto" },
  DEUDAS_PENDIENTES: { bloque: "deudas_pendientes", etiqueta: "Deudas Pendientes Otros" },
};

const CATEGORIAS_DE_GASTO: DetalleCategoria[] = [
  "GASTOS_FIJOS",
  "PAGOS_PROYECTOS",
  "PAGOS_EXTRAS",
  "PAGOS_PENDIENTES_ALBERTO",
  "DEUDAS_PENDIENTES",
  "IMPUESTOS_POR_PAGAR",
  "APLAZAMIENTO_IMPUESTOS",
];

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(new RegExp("[̀-ͯ]", "g"), "")
    .toLowerCase();
}

/**
 * Dos palabras "son la misma" si son iguales o comparten un prefijo largo —
 * cubre plural/singular y variantes cortas sin exigir coincidencia exacta.
 * Misma técnica que palabrasParecidas en holded/write.ts (buscarContactosParecidos).
 */
function palabrasParecidas(a: string, b: string): boolean {
  if (a === b) return true;
  const minLen = Math.min(a.length, b.length);
  if (minLen < 4) return false;
  const prefijo = Math.min(5, minLen);
  return a.slice(0, prefijo) === b.slice(0, prefijo);
}

function palabrasDe(texto: string): string[] {
  return normalizar(texto)
    .split(/\s+/)
    .filter((p) => p.length >= 3);
}

function scoreTexto(palabrasObjetivo: string[], palabrasCandidato: string[]): number {
  return palabrasObjetivo
    .filter((po) => palabrasCandidato.some((pc) => palabrasParecidas(po, pc)))
    .reduce((suma, p) => suma + p.length, 0);
}

/**
 * Sugiere en qué categoría del cashflow debería ir un GASTO nuevo (nunca se
 * llama para ingresos — esos se resuelven solos por el signo, sin
 * ambigüedad, pedido explícito de Carlos). Compara la descripción contra el
 * historial YA registrado en cada categoría — mismo principio que
 * buscarContactosParecidos en Holded: lo que ya se clasificó antes ahí es
 * la mejor pista de dónde va algo parecido, en vez de adivinar por
 * palabras clave fijas que se desactualizan. Nunca decide sola: devuelve
 * las categorías rankeadas para que el usuario confirme cuál es.
 */
export function sugerirCategoriasGasto(descripcion: string, registros: DetalleRegistro[]): CategoriaSugerida[] {
  const palabrasObjetivo = palabrasDe(descripcion);

  const puntuaciones = new Map<DetalleCategoria, number>();

  for (const categoria of CATEGORIAS_DE_GASTO) {
    let mejor = 0;
    for (const r of registros) {
      if (r.categoria !== categoria) continue;
      const texto = r.concepto || r.cliente || r.proyecto || "";
      if (!texto) continue;
      const score = scoreTexto(palabrasObjetivo, palabrasDe(texto));
      if (score > mejor) mejor = score;
    }
    puntuaciones.set(categoria, mejor);
  }

  return CATEGORIAS_DE_GASTO.map((categoria) => ({
    categoria,
    bloque: CATEGORIA_A_BLOQUE[categoria].bloque,
    etiqueta: CATEGORIA_A_BLOQUE[categoria].etiqueta,
    score: puntuaciones.get(categoria) ?? 0,
  })).sort((a, b) => b.score - a.score);
}

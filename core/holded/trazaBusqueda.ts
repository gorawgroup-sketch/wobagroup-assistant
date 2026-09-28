/**
 * Traza de una búsqueda de cargo bancario: qué cuentas se miraron y, sobre todo, qué cargos con el MISMO importe se
 * descartaron y por qué regla. Caso real 2026-09-28: el sistema decía «no encontré ningún movimiento» aunque el cargo
 * existía y había sido descartado por el nombre; sin esta información cada diagnóstico costaba horas de leer logs (que
 * además se borran en cada despliegue). La traza nunca cambia el resultado de la búsqueda.
 */
export interface EntradaTraza {
  movementId: string;
  cuenta?: string;
  descripcion: string;
  monto: number;
  moneda: string;
  fecha: string;
  resultado: "ofrecido" | "descartado";
  motivo: string;
}

export interface TrazaBusqueda {
  cuentasRevisadas: Array<{ id: string; nombre?: string; moneda?: string }>;
  desde: string;
  hasta: string;
  /** Solo los cargos con el mismo importe (dentro de la tolerancia): son los únicos que pudieron ser el buscado. */
  mismoImporte: EntradaTraza[];
}

export function crearTrazaBusqueda(): TrazaBusqueda {
  return { cuentasRevisadas: [], desde: "", hasta: "", mismoImporte: [] };
}

/** Texto corto para el operador: qué se revisó y qué cargos del mismo importe se descartaron y por qué. */
export function describirTrazaBusqueda(traza: TrazaBusqueda | undefined): string {
  if (!traza || traza.cuentasRevisadas.length === 0) return "";
  const cuentas = traza.cuentasRevisadas.map((c) => [c.nombre, c.moneda].filter(Boolean).join(" ")).filter(Boolean).join(", ");
  const cabecera = `Revisé ${traza.cuentasRevisadas.length} cuenta(s) activa(s)${cuentas ? ` (${cuentas})` : ""}${traza.desde ? ` entre ${traza.desde} y ${traza.hasta}` : ""}.`;
  const descartados = traza.mismoImporte.filter((e) => e.resultado === "descartado");
  const ofrecidos = traza.mismoImporte.filter((e) => e.resultado === "ofrecido");
  if (descartados.length === 0 && ofrecidos.length === 0) return `${cabecera} No había ningún cargo con ese importe exacto en esas cuentas.`;
  const linea = (e: EntradaTraza) => `• “${e.descripcion || "(sin descripción)"}” (${e.fecha}, ${e.monto.toFixed(2)} ${e.moneda}): ${e.motivo}`;
  const partes = [cabecera];
  if (ofrecidos.length > 0) partes.push(`Cargos con ese importe que ofrecí:\n${ofrecidos.slice(0, 5).map(linea).join("\n")}`);
  if (descartados.length > 0) {
    partes.push(`Cargos con el mismo importe que descarté:\n${descartados.slice(0, 5).map(linea).join("\n")}${descartados.length > 5 ? `\n… y ${descartados.length - 5} más.` : ""}`);
  }
  return partes.join(" ");
}

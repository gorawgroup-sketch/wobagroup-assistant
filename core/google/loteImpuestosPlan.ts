import type { SeccionImpuestos, SeccionImpuestosLeida, FilaImpuesto } from "./cashflowImpuestos";
import type { OperacionLoteImpuestos } from "./pendienteLoteImpuestosStore";

/**
 * Del pedido («corrige el MOD 115 de WOBA a X», «añade el 303 de EWORKS 3T en la S43») al lote que se propone con botón: resuelve cada operación contra lo que YA hay en las
 * secciones de impuestos del cashflow (fila, semana y valor actuales), detecta duplicados y ambigüedades y redacta la línea de cada una. Pura: no lee ni escribe nada.
 * El lote lo ejecuta loteImpuestosCallbackHandler.ts tras la aprobación, fila a fila y verificado.
 */
export interface PeticionOperacionImpuestos {
  accion: "alta" | "correccion";
  /** Nombre del impuesto tal como figura (o figurará) en el cashflow, p. ej. «MOD 115 WOBA Q3». */
  impuesto: string;
  /** alta: semana de pago («S43»). correccion: la NUEVA semana, si cambia. */
  semana?: string;
  /** alta: obligatorio. correccion: el NUEVO valor, si cambia. */
  valor?: number;
  anio?: string;
  /** alta: sección (por defecto «impuestos_por_pagar»). */
  seccion?: SeccionImpuestos;
  /** correccion: semana ACTUAL de la fila, para distinguir varias filas del mismo impuesto (p. ej. cuotas de un aplazamiento). */
  semana_actual?: string;
}

export interface PlanLote { operaciones: OperacionLoteImpuestos[]; errores: string[]; avisos: string[] }

const SEMANA = /^S\d{2}$/;
const norm = (t: string): string => t.trim().replace(/\s+/g, " ").toUpperCase();
const euros = (n: number): string => `${new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} €`;

/** «€1,867.22», «1867.22», «1.867,22 €» → número, o undefined. */
export function valorDeCelda(texto: string): number | undefined {
  const t = texto.replace(/[€\s]/g, "");
  if (!t) return undefined;
  const n = Number(t.includes(",") && t.includes(".") ? (t.lastIndexOf(",") > t.lastIndexOf(".") ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "")) : t.includes(",") ? t.replace(",", ".") : t);
  return Number.isFinite(n) ? n : undefined;
}

export function planificarLote(secciones: Record<SeccionImpuestos, SeccionImpuestosLeida>, peticiones: readonly PeticionOperacionImpuestos[], anioPorDefecto: string): PlanLote {
  const operaciones: OperacionLoteImpuestos[] = [], errores: string[] = [], avisos: string[] = [];
  const todas = (Object.keys(secciones) as SeccionImpuestos[]).flatMap((s) => secciones[s].filas.filter((f) => f.impuesto).map((f) => ({ seccion: s, f })));
  const vistos = new Set<string>();

  peticiones.forEach((p, i) => {
    const etiqueta = `Operación ${i + 1} («${p.impuesto}»)`;
    if (!p.impuesto?.trim()) { errores.push(`${etiqueta}: falta el nombre del impuesto.`); return; }
    if (p.semana !== undefined && !SEMANA.test(p.semana)) { errores.push(`${etiqueta}: la semana debe tener el formato «S43».`); return; }
    if (p.valor !== undefined && (!Number.isFinite(p.valor) || p.valor <= 0)) { errores.push(`${etiqueta}: el valor debe ser un número mayor que cero.`); return; }

    if (p.accion === "alta") {
      if (!p.semana || p.valor === undefined) { errores.push(`${etiqueta}: un alta necesita semana y valor.`); return; }
      const seccion = p.seccion ?? "impuestos_por_pagar";
      const dup = secciones[seccion].filas.find((f) => norm(f.impuesto) === norm(p.impuesto) && f.semana === p.semana && f.valor !== "");
      if (dup) { errores.push(`${etiqueta}: ya existe en la fila ${dup.fila} (${dup.semana}, ${dup.valor}); si hay que cambiarlo, es una corrección.`); return; }
      const clave = `${seccion}|${norm(p.impuesto)}|${p.semana}`;
      if (vistos.has(clave)) { errores.push(`${etiqueta}: repetida en el mismo pedido.`); return; }
      vistos.add(clave);
      operaciones.push({ tipo: "alta", descripcion: `NUEVO · ${p.impuesto.trim()} (${p.semana}): ${euros(p.valor)}`, datos: { seccion, impuesto: p.impuesto.trim(), semana: p.semana, valor: p.valor, anio: p.anio ?? anioPorDefecto } });
      return;
    }

    if (p.semana === undefined && p.valor === undefined && p.anio === undefined) { errores.push(`${etiqueta}: una corrección necesita un valor, una semana o un año nuevos.`); return; }
    const coinciden = todas.filter(({ f }) => norm(f.impuesto) === norm(p.impuesto) && (!p.semana_actual || f.semana === p.semana_actual));
    if (coinciden.length === 0) {
      const parecidas = todas.filter(({ f }) => norm(f.impuesto).includes(norm(p.impuesto).split(" ")[1] ?? "")).slice(0, 5).map(({ f }) => `«${f.impuesto}» (${f.semana})`);
      errores.push(`${etiqueta}: no encuentro esa fila en el cashflow${p.semana_actual ? ` en la semana ${p.semana_actual}` : ""}.${parecidas.length ? ` Parecidas: ${parecidas.join(", ")}.` : ""}`);
      return;
    }
    if (coinciden.length > 1) { errores.push(`${etiqueta}: hay ${coinciden.length} filas con ese nombre (${coinciden.map(({ f }) => f.semana).join(", ")}); indica semana_actual.`); return; }
    const { f } = coinciden[0] as { f: FilaImpuesto };
    const actual = valorDeCelda(f.valor);
    if (p.valor !== undefined && actual !== undefined && Math.abs(actual - p.valor) < 0.011 && (p.semana === undefined || p.semana === f.semana) && (p.anio === undefined || p.anio === f.anio)) {
      avisos.push(`${f.impuesto} (${f.semana}) ya está en ${euros(actual)}: sin cambios.`); return;
    }
    if (vistos.has(`fila${f.fila}`)) { errores.push(`${etiqueta}: la fila ${f.fila} ya se corrige en otra operación del pedido.`); return; }
    vistos.add(`fila${f.fila}`);
    const cambios = [
      p.valor !== undefined ? `${actual !== undefined ? euros(actual) : "(vacío)"} → ${euros(p.valor)}` : "",
      p.semana !== undefined && p.semana !== f.semana ? `semana ${f.semana} → ${p.semana}` : "",
      p.anio !== undefined && p.anio !== f.anio ? `año ${f.anio} → ${p.anio}` : "",
    ].filter(Boolean).join(", ");
    operaciones.push({ tipo: "correccion", descripcion: `${f.impuesto} (${f.semana}): ${cambios}`, datos: {
      fila: f.fila, esperado: { impuesto: f.impuesto, semana: f.semana, ...(actual !== undefined ? { valor: actual } : {}) },
      nuevo: { ...(p.semana !== undefined ? { semana: p.semana } : {}), ...(p.valor !== undefined ? { valor: p.valor } : {}), ...(p.anio !== undefined ? { anio: p.anio } : {}) } } });
  });
  return { operaciones, errores, avisos };
}

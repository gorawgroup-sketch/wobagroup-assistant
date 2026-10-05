import { randomUUID } from "node:crypto";
import { agregarFila, eliminarFila, leerFilas } from "../google/sheetsKeyValueStore";

/**
 * Reglas «ya está sumado en otra línea» del cashflow (pedido de Carlos, 2026-10-05): muchos movimientos del banco NO tienen una fila
 * propia en el cashflow porque la hoja los suma en una sola línea (p. ej. todas las nóminas en «Nóminas»). El cruce Holded↔cashflow los
 * daba por «sin registrar» cada semana. Carlos puede explicarlo UNA vez («esto va en la línea Nóminas, sumado con Heidi Antunes») y el
 * sistema aprende una regla: los movimientos de esa empresa cuyo concepto contiene esas palabras clave dejan de reportarse como
 * pendientes. Misma idea que los demás almacenes de aprendizaje (alias de proveedor, duplicados confirmados, cuenta corregida).
 *
 * Una regla NUNCA borra nada del banco, de Holded ni del cashflow: solo evita volver a preguntar por ese tipo de movimiento, y el
 * informe siempre dice cuántos quedaron cubiertos por reglas, para que no haya nada oculto.
 */
export interface ReglaAgregada {
  id: string;
  empresa: "WOBA" | "EWORKS";
  /** Palabras clave NORMALIZADAS (sin tildes, minúsculas); el concepto debe contenerlas todas. */
  palabrasClave: string[];
  /** Nombre de la línea del cashflow que ya los incluye (informativo). */
  lineaCashflow: string;
  /** Lo que Carlos explicó, tal cual, para que cualquiera entienda por qué existe la regla. */
  explicacion: string;
  tipo: "gasto" | "ingreso";
  creadoEn: string;
}

export const normalizarTextoRegla = (t: string): string =>
  t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Palabras que no identifican un tipo de movimiento: meses, conectores y términos bancarios genéricos. */
const PALABRAS_GENERICAS = new Set([
  "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "setiembre", "octubre", "noviembre", "diciembre",
  "para", "pago", "pagos", "transferencia", "transfer", "cargo", "abono", "concepto", "factura", "recibo", "mensual", "semana", "cuenta",
  "from", "payment", "sepa", "banco", "bank", "este", "esta", "esto", "linea", "fila", "suma", "sumado", "sumada", "incluido", "incluida",
]);

/** Palabras del concepto (≥4 letras, no genéricas, no numéricas) que aparecen también en la explicación: lo que identifica el grupo. */
export function palabrasClaveDesdeExplicacion(concepto: string, explicacion: string): string[] {
  const exp = ` ${normalizarTextoRegla(explicacion)} `;
  const vistas = new Set<string>();
  for (const w of normalizarTextoRegla(concepto).split(" ")) {
    if (w.length < 4 || /^\d+$/.test(w) || PALABRAS_GENERICAS.has(w) || vistas.has(w)) continue;
    // «nomina» (concepto) debe reconocerse en «nóminas» (explicación): coincide por prefijo en cualquier sentido.
    const coincide = exp.split(" ").some((e) => e.length >= 4 && (e.startsWith(w) || w.startsWith(e)));
    if (coincide) vistas.add(w);
  }
  return [...vistas];
}

/** Nombre de la línea tras «línea/fila/rubro [que dice/llamada] …»; si no se dice, la explicación entera recortada. */
export function lineaDesdeExplicacion(explicacion: string): string {
  const m = /(?:l[ií]nea|fila|rubro|categor[ií]a)\s+(?:que\s+dice\s+|llamada\s+|de\s+)?[«"“']?([^,.;:"»”'\n]{3,60}?)(?:\s+(?:y|que|ya|junto|con|del|en)\b|[,.;:"»”'\n]|$)/i.exec(explicacion);
  return (m?.[1] ?? explicacion).trim().slice(0, 80);
}

export function cubiertoPorRegla(
  mov: { empresa: string; descripcion: string; esIngreso?: boolean },
  reglas: ReglaAgregada[]
): ReglaAgregada | undefined {
  const texto = normalizarTextoRegla(mov.descripcion);
  const palabras = new Set(texto.split(" "));
  return reglas.find((r) => r.empresa === mov.empresa && r.tipo === (mov.esIngreso ? "ingreso" : "gasto") && r.palabrasClave.length > 0 &&
    // Palabra completa o su plural simple («nomina» cubre «nominas»); nunca por prefijo suelto (un proveedor «Nominas SL» no es una nómina).
    r.palabrasClave.every((k) => palabras.has(k) || palabras.has(`${k}s`) || palabras.has(`${k}es`)));
}

export function aplicarReglasAgregadas<T extends { empresa: string; descripcion: string; valorEur?: number; esIngreso?: boolean }>(
  movimientos: T[],
  reglas: ReglaAgregada[]
): { pendientes: T[]; cubiertos: Array<{ movimiento: T; regla: ReglaAgregada }> } {
  const pendientes: T[] = []; const cubiertos: Array<{ movimiento: T; regla: ReglaAgregada }> = [];
  for (const m of movimientos) {
    const esIngreso = m.esIngreso ?? (m.valorEur !== undefined ? m.valorEur > 0 : false);
    const regla = cubiertoPorRegla({ empresa: m.empresa, descripcion: m.descripcion, esIngreso }, reglas);
    if (regla) cubiertos.push({ movimiento: m, regla }); else pendientes.push(m);
  }
  return { pendientes, cubiertos };
}

export function textoCubiertos(cubiertos: Array<{ movimiento: { descripcion: string; valorEur?: number }; regla: ReglaAgregada }>): string {
  if (cubiertos.length === 0) return "";
  const porLinea = new Map<string, number>();
  for (const c of cubiertos) porLinea.set(c.regla.lineaCashflow, (porLinea.get(c.regla.lineaCashflow) ?? 0) + 1);
  return `ℹ️ ${cubiertos.length} movimiento(s) del banco no se reportan porque una regla aprendida dice que ya van sumados en otra línea: ` +
    [...porLinea].map(([l, n]) => `${n} en «${l}»`).join(", ") + ".";
}

/* ───────── Almacén (Sheets, pestaña oculta) ───────── */
const TAB = "_reglas_cashflow_agregadas";
const HEADERS = ["id", "empresa", "palabrasClave", "lineaCashflow", "explicacion", "tipo", "creadoEn"];

export async function listarReglasAgregadas(): Promise<ReglaAgregada[]> {
  return (await leerFilas(TAB, HEADERS.length, HEADERS)).map((f) => ({
    id: f.valores[0] ?? "", empresa: (f.valores[1] ?? "WOBA") as ReglaAgregada["empresa"],
    palabrasClave: (f.valores[2] ?? "").split(",").map((p) => p.trim()).filter(Boolean),
    lineaCashflow: f.valores[3] ?? "", explicacion: f.valores[4] ?? "", tipo: f.valores[5] === "ingreso" ? ("ingreso" as const) : ("gasto" as const), creadoEn: f.valores[6] ?? "",
  })).filter((r) => r.id && r.palabrasClave.length > 0);
}

export async function registrarReglaAgregada(d: Omit<ReglaAgregada, "id" | "creadoEn">): Promise<ReglaAgregada> {
  const regla: ReglaAgregada = { ...d, id: randomUUID().slice(0, 8), creadoEn: new Date().toISOString() };
  const existentes = await listarReglasAgregadas();
  const clave = (r: Pick<ReglaAgregada, "empresa" | "palabrasClave" | "tipo">) => `${r.empresa}|${r.tipo}|${[...r.palabrasClave].sort().join(",")}`;
  const previa = existentes.find((r) => clave(r) === clave(regla));
  if (previa) return previa; // idempotente: la misma regla no se duplica
  await agregarFila(TAB, HEADERS.length, HEADERS, [regla.id, regla.empresa, regla.palabrasClave.join(","), regla.lineaCashflow, regla.explicacion.slice(0, 500), regla.tipo, regla.creadoEn]);
  return regla;
}

export async function quitarReglaAgregada(id: string): Promise<boolean> {
  const filas = await leerFilas(TAB, HEADERS.length, HEADERS);
  const fila = filas.find((f) => f.valores[0] === id);
  if (!fila) return false;
  await eliminarFila(TAB, fila.rowIndex, HEADERS);
  return true;
}

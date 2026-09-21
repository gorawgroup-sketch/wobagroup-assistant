import { fetchDetalleRegistros, type DetalleCategoria, type DetalleRegistro, type EmpresaTag } from "./cashflowSheet";
import type { ProblemaEstructuraDatos } from "./cashflowLayout";
import { esProblemaEstructuraSevero, parsearImporteCashflow } from "../cashflow/parseoImportes";
import { montosCercanos } from "../utils/montos";
import { esSemanaValida, normalizarSemana } from "../utils/semanaCashflow";
import { palabrasParecidas, textosParecidos } from "../utils/textoParecido";

/**
 * Motor único de búsqueda sobre la hoja DATOS (las 10 categorías). Lo usan consultar_cashflow_detalle
 * (modo "interactivo") y consultar_proximas_alertas (modo "concepto", que SUMA importes y por eso
 * conserva la semántica conservadora de siempre: solo nombre, exacto o parecido, sin sinónimos ni importes).
 *
 * Caso real (2026-09-21, EWORKS): "Providencia de apremio" (S38, 747,31 €) y "Sanción AEAT" (S41,
 * 137,62 €) SÍ estaban en «Impuestos por Pagar», pero Wobi respondió que "NO están en el cashflow".
 * Causas, verificadas en vivo contra la hoja real:
 *  1. El filtro `empresa` descartaba TODA fila sin etiqueta de empresa — y Impuestos por Pagar (como
 *     Gastos Fijos, Aplazamientos o Gastos Consultores; 83 de las 131 filas) no tiene columna EMPRESA.
 *     Ahora una fila sin empresa NO se descarta: se devuelve marcada, o con la empresa inferida por su
 *     nombre ("MOD 303 EWORKS Q2"); solo se aparta lo que la hoja o el nombre atribuyen a la OTRA empresa
 *     y se dice cuántas y cuáles.
 *  2. No existía búsqueda por importe ni por el título de la sección.
 *  3. La comparación distinguía tildes y no aceptaba sinónimos obvios (Hacienda ≈ AEAT).
 *  4. Un resultado vacío se presentaba como prueba de ausencia. Ahora, si las pistas dejan el resultado
 *     vacío, se van relajando de una en una (semana, empresa, sección, importe, nombre) y se dice cuál;
 *     si de verdad no hay nada, se enumeran los intentos REALES y se avisa de cualquier fila que la
 *     lectura de la hoja no pudo interpretar (importe vacío, sección no localizada...).
 *
 * Nota contable: `empresa` sigue siendo undefined = "no atribuible". Aquí solo se BUSCA; los informes
 * contables (cruce con Holded) siguen sin asignar esas filas a ninguna empresa.
 */

export interface InfoCategoriaCashflow {
  titulo: string;
  /** Otras formas de nombrar el título de la sección, tal como las diría una persona. */
  alias: string[];
}

export const CATEGORIAS_CASHFLOW: Record<DetalleCategoria, InfoCategoriaCashflow> = {
  INGRESOS: { titulo: "Ingresos", alias: ["ingresos woba group", "cobros"] },
  PAGOS_PROYECTOS: { titulo: "Pagos Proyectos", alias: ["pagos a proyectos", "pagos de proyectos"] },
  PAGOS_EXTRAS: { titulo: "Pagos Extras", alias: ["pago extra", "pagos extra"] },
  IMPUESTOS_POR_PAGAR: { titulo: "Impuestos por Pagar", alias: ["impuestos pendientes", "impuestos a pagar"] },
  APLAZAMIENTO_IMPUESTOS: {
    titulo: "Aplazamiento Impuestos por Pagar",
    alias: ["aplazamiento de impuestos", "aplazamientos", "aplazamiento"],
  },
  GASTOS_FIJOS: { titulo: "Gastos Fijos", alias: ["gasto fijo"] },
  GASTOS_CONSULTORES_MES_ACTUAL: { titulo: "Gastos Consultores Mes Actual", alias: ["consultores mes actual"] },
  GASTOS_CONSULTORES_PROXIMO_MES: {
    titulo: "Gastos Consultores Próximo Mes",
    alias: ["consultores proximo mes", "consultores mes siguiente"],
  },
  PAGOS_PENDIENTES_ALBERTO: { titulo: "Pagos Pendientes Alberto", alias: ["pendientes alberto", "pagos a alberto"] },
  DEUDAS_PENDIENTES: { titulo: "Deudas Pendientes Otros", alias: ["deudas pendientes", "deudas con otros"] },
};

const TODAS_LAS_CATEGORIAS = Object.keys(CATEGORIAS_CASHFLOW) as DetalleCategoria[];

/**
 * Sinónimos de uso común en la contabilidad del grupo. Solo se aplican en el modo interactivo, por
 * PALABRA COMPLETA (nunca por subcadena: "iva" no está en "definitivas"), y lo que se encuentra por esta
 * vía siempre se marca como aproximado.
 */
const SINONIMOS: Array<{ termino: string; equivalentes: string[] }> = [
  // "Hacienda" es el término amplio: nombra a la AEAT y todo lo que emite o exige (modelos, providencias, sanciones).
  // Los modelos tributarios (MOD 111/115/303/200) son de la AEAT; "impuestos" a secas NO se usa: también
  // nombra la Seguridad Social ("Impuestos seg social") y arrastraría filas que no son de Hacienda.
  { termino: "hacienda", equivalentes: ["aeat", "tributaria", "providencia", "apremio", "sancion", "mod 111", "mod 115", "mod 200", "mod 303"] },
  // El resto son equivalencias estrechas: una "sanción" no es un "apremio", ni "AEAT" implica cualquier deuda.
  { termino: "aeat", equivalentes: ["hacienda", "tributaria"] },
  { termino: "tributaria", equivalentes: ["aeat", "hacienda"] },
  { termino: "apremio", equivalentes: ["providencia"] },
  { termino: "providencia", equivalentes: ["apremio"] },
  { termino: "sancion", equivalentes: ["multa"] },
  { termino: "multa", equivalentes: ["sancion"] },
  { termino: "iva", equivalentes: ["mod 303"] },
  { termino: "irpf", equivalentes: ["mod 111", "mod 115", "retenciones"] },
  { termino: "retenciones", equivalentes: ["mod 111", "mod 115", "irpf"] },
  { termino: "seguridad social", equivalentes: ["seg social", "tgss"] },
];

const PALABRAS_VACIAS = new Set([
  "de", "del", "la", "el", "los", "las", "por", "en", "y", "a", "al", "un", "una", "cashflow",
  "seccion", "zona", "area", "tabla", "categoria", "titulo",
]);

/** Máximo de líneas que se devuelven al modelo (Telegram corta a 4096 caracteres). */
export const LIMITE_LINEAS_CASHFLOW = 40;

/** Minúsculas, sin tildes ni puntuación: "Sanción AEAT" y "sancion aeat" son lo mismo. */
export function normalizarBusqueda(texto: string): string {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function palabrasSignificativas(texto: string): string[] {
  return normalizarBusqueda(texto)
    .split(" ")
    .filter((p) => p && !PALABRAS_VACIAS.has(p) && (p.length >= 3 || /\d/.test(p)));
}

/** Palabra completa: ' hacienda ' está en ' pago hacienda q1 ', pero ' iva ' no está en ' definitivas '. */
function contienePalabras(texto: string, buscado: string): boolean {
  return ` ${texto} `.includes(` ${buscado} `);
}

interface Fila {
  r: DetalleRegistro;
  /** Nombre normalizado (cliente, proyecto, concepto). El banco NO se busca: "Caixa" no es un nombre. */
  texto: string;
  /** El mismo nombre solo en minúsculas y sin tildes, CON su puntuación (lo que compara el modo "concepto"). */
  textoLigero: string;
  palabras: string[];
}

/** Minúsculas y sin tildes, sin tocar la puntuación. */
function sinTildes(texto: string): string {
  return String(texto ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function prepararFila(r: DetalleRegistro): Fila {
  const crudo = [r.cliente, r.proyecto, r.concepto].filter(Boolean).join(" ");
  const texto = normalizarBusqueda(crudo);
  return { r, texto, textoLigero: sinTildes(crudo), palabras: texto.split(" ").filter(Boolean) };
}

// Sin cuantificadores anidados sobre \s: una cadena enorme no puede provocar backtracking cuadrático.
const RE_IMPORTE = /^[€$£\s]*-?\d[\d.,]*(?:\s*(?:€|eur|euros?))?\s*$/i;

/** Si el texto es en realidad un importe ("747", "747,31 €", "€137.62"), devuelve su valor. */
export function importeDeTexto(texto: string): number | undefined {
  if (String(texto ?? "").length > 60 || !RE_IMPORTE.test(String(texto ?? ""))) return undefined;
  const valor = parsearImporteCashflow(texto);
  return Number.isFinite(valor) && valor !== 0 ? valor : undefined;
}

/**
 * "Providencia de apremio 747,31" → nombre + importe. Solo se toma como importe un número con dos decimales
 * ("747,31", "1186,00", "1.186,00") o con símbolo de moneda ("137€", "€137", "137 €", "137 euros"); nunca fechas
 * ("12.05.2025"), porcentajes ("21,00%") ni números sueltos: "MOD 303" es un nombre, no 303 €.
 */
function separarTextoEImporte(texto: string): { texto: string; valor?: number } {
  const fichas = texto.split(/\s+/).filter(Boolean);
  for (let i = 0; i < fichas.length; i++) {
    const ficha = fichas[i];
    const siguiente = fichas[i + 1];
    const monedaSiguiente = siguiente !== undefined && /^(?:€|eur|euros?)$/i.test(siguiente);
    const monedaPegada = /^[€$£]\d/.test(ficha) || /\d[€$£]$/.test(ficha) || /\d(?:eur|euros?)$/i.test(ficha);
    const limpio = ficha.replace(/^[€$£]/, "").replace(/(?:[€$£]|eur|euros?)$/i, "");
    if (!/^\d+(?:[.,]\d+)*$/.test(limpio)) continue;
    const esFecha = /^\d{1,2}[.,]\d{1,2}[.,]\d{2,4}$/.test(limpio);
    const dosDecimales = /[.,]\d{2}$/.test(limpio) && !esFecha;
    if (!monedaSiguiente && !monedaPegada && !dosDecimales) continue;
    const valor = parsearImporteCashflow(limpio);
    const resto = fichas.filter((_, j) => j !== i && !(monedaSiguiente && j === i + 1)).join(" ").trim();
    if (!resto || !Number.isFinite(valor) || valor === 0) return { texto };
    return { texto: resto, valor };
  }
  return { texto };
}

/**
 * Categorías que nombra un texto. Igualdad exacta con el título o un alias → solo esa. Si no (y no se
 * pide exactitud), todas aquellas cuyo título contiene todas las palabras del texto (p. ej.
 * "consultores" → las dos tablas de consultores).
 */
export function categoriasPorTitulo(texto: string, exactoUnicamente = false): DetalleCategoria[] {
  const normalizado = normalizarBusqueda(texto);
  if (!normalizado) return [];
  const sinVacias = palabrasSignificativas(texto).join(" ");
  const exactas = TODAS_LAS_CATEGORIAS.filter((c) => {
    const info = CATEGORIAS_CASHFLOW[c];
    return [info.titulo, ...info.alias].some(
      (t) => normalizarBusqueda(t) === normalizado || (sinVacias !== "" && palabrasSignificativas(t).join(" ") === sinVacias)
    );
  });
  if (exactas.length > 0 || exactoUnicamente) return exactas;

  const palabras = palabrasSignificativas(texto);
  if (palabras.length === 0) return [];
  return TODAS_LAS_CATEGORIAS.filter((c) => {
    const titulo = palabrasSignificativas(CATEGORIAS_CASHFLOW[c].titulo);
    return palabras.every((p) => titulo.some((t) => palabrasParecidas(p, t)));
  });
}

/**
 * Palabras que identifican por sí solas una o dos secciones. Una palabra genérica del título ("proyectos", "otros",
 * "actual", "gastos", "pagos") no distingue nada: volcaría tablas enteras.
 */
const PALABRAS_DISTINTIVAS_SECCION = ["impuestos", "aplazamiento", "aplazamientos", "consultores", "ingresos", "deudas", "alberto"];

/** Una sola palabra distintiva ("impuestos", "consultores", "aplazamiento"): se ofrece esa sección como coincidencia aproximada. */
function seccionesPorPalabraDistintiva(texto: string): DetalleCategoria[] {
  const palabras = palabrasSignificativas(texto);
  if (palabras.length !== 1 || !PALABRAS_DISTINTIVAS_SECCION.some((d) => palabrasParecidas(palabras[0], d))) return [];
  return categoriasPorTitulo(texto);
}

export { normalizarSemana };

export type AtribucionEmpresa = "confirmada" | "inferida_por_nombre" | "sin_empresa" | "otra";
export type CalidadCoincidencia = "exacta" | "aproximada";
export type Criterio = "semana" | "empresa" | "categoria" | "valor" | "texto";
export type ModoBusqueda = "interactivo" | "concepto";

export interface ConsultaCashflow {
  semana?: string;
  empresa?: EmpresaTag;
  /** Nombre, concepto o título de sección. Si parece un importe, también se busca por valor. */
  texto?: string;
  /** Importe buscado (en valor absoluto). */
  valor?: number;
  /** Diferencia máxima aceptada para coincidencia "cercana" por importe. Por defecto entre 1 € y 5 €. */
  toleranciaEur?: number;
  /** Título de la sección, en lenguaje natural ("impuestos por pagar", "aplazamiento"). */
  categoria?: string;
}

export interface CoincidenciaCashflow {
  registro: DetalleRegistro;
  calidad: CalidadCoincidencia;
  motivos: string[];
  atribucion: AtribucionEmpresa;
  /** Empresa que el NOMBRE de la fila indica ("MOD 303 EWORKS Q2"), cuando la hoja no la etiqueta. */
  empresaPorNombre?: EmpresaTag;
  /** El nombre coincide solo por palabras parecidas (la evidencia más débil). */
  debil: boolean;
}

export interface ApartadaPorEmpresa {
  nombre: string;
  semana: string;
  valor: string;
}

export interface ResultadoConsultaCashflow {
  coincidencias: CoincidenciaCashflow[];
  /** true si hay coincidencias y NINGUNA es exacta. */
  aproximado: boolean;
  /** Pistas que hubo que quitar para encontrar algo. */
  filtrosRelajados: Criterio[];
  /** Coincidencias por contenido que el filtro de empresa apartó por ser, según la hoja o su nombre, de la OTRA empresa. */
  apartadasPorEmpresa: ApartadaPorEmpresa[];
  /** Intentos realmente ejecutados, en orden, con cuántas filas dio cada uno. */
  intentos: Array<{ descripcion: string; filas: number }>;
  totalRegistros: number;
  porCategoria: Record<string, number>;
  /** Secciones reconocidas por el texto o por `categoria` (si las hubo). */
  categoriasReconocidas: DetalleCategoria[];
  /** `categoria` que no coincide con ninguna sección. */
  categoriaNoReconocida?: string;
  /** Lo que se exigió realmente (tras normalizar la consulta). */
  consultaEfectiva: ConsultaCashflow;
}

/** Empresa que indica el nombre de una fila sin etiqueta: solo si nombra a UNA de las dos, como palabra completa. */
function empresaPorNombre(f: Fila): EmpresaTag | undefined {
  const woba = f.palabras.includes("woba");
  const eworks = f.palabras.includes("eworks");
  return woba && !eworks ? "WOBA" : eworks && !woba ? "EWORKS" : undefined;
}

function atribuir(f: Fila, empresa?: EmpresaTag): { atribucion: AtribucionEmpresa; empresaPorNombre?: EmpresaTag } {
  if (f.r.empresa) return { atribucion: !empresa || f.r.empresa === empresa ? "confirmada" : "otra" };
  const porNombre = empresaPorNombre(f);
  if (!porNombre) return { atribucion: "sin_empresa" };
  return { atribucion: !empresa || porNombre === empresa ? "inferida_por_nombre" : "otra", empresaPorNombre: porNombre };
}

function toleranciaCentimos(valor: number, explicita?: number): number {
  const eur = explicita !== undefined ? explicita : Math.min(5, Math.max(1, Math.abs(valor) * 0.005));
  return Math.round(eur * 100);
}

interface Evaluacion {
  calidad: CalidadCoincidencia;
  motivo: string;
  /** Coincidencia por palabras parecidas (la más débil): se descarta si hay una exacta. */
  parecido?: boolean;
}

function evaluarTexto(consulta: string, f: Fila, modo: ModoBusqueda): Evaluacion | undefined {
  if (modo === "concepto") {
    // Modo que SUMA importes (consultar_proximas_alertas): la comparación de siempre — subcadena y, si no hay,
    // palabras parecidas — solo que sin distinguir tildes. La puntuación cuenta: una clave como "(pago" no
    // debe convertirse en "pago" y enganchar cualquier fila que lo contenga.
    const buscado = sinTildes(consulta).trim();
    if (!buscado) return undefined;
    if (f.textoLigero.includes(buscado)) return { calidad: "exacta", motivo: `el nombre contiene «${consulta.trim()}»` };
    if (textosParecidos(consulta, f.textoLigero)) return { calidad: "aproximada", motivo: "el nombre es parecido (palabras similares)", parecido: true };
    return undefined;
  }
  const objetivo = normalizarBusqueda(consulta);
  if (!objetivo) return undefined;
  // Nombres cortos o numéricos ("luz", "aws", "303") solo cuentan como exactos por palabra completa.
  const corto = objetivo.length <= 3;
  if (corto ? contienePalabras(f.texto, objetivo) : f.texto.includes(objetivo)) {
    return { calidad: "exacta", motivo: `el nombre contiene «${consulta.trim()}»` };
  }
  const palabras = palabrasSignificativas(consulta);
  if (palabras.length > 1 && palabras.every((p) => f.texto.includes(p) || f.palabras.some((w) => palabrasParecidas(p, w)))) {
    return { calidad: "exacta", motivo: `el nombre contiene todas las palabras de «${consulta.trim()}»` };
  }
  if (textosParecidos(consulta, f.texto)) return { calidad: "aproximada", motivo: "el nombre es parecido (palabras similares)", parecido: true };
  if (corto && f.texto.includes(objetivo)) return { calidad: "aproximada", motivo: `el nombre contiene «${consulta.trim()}» dentro de otra palabra`, parecido: true };
  return undefined;
}

function evaluarPorSinonimos(consulta: string, f: Fila): Evaluacion | undefined {
  const objetivo = normalizarBusqueda(consulta);
  for (const { termino, equivalentes } of SINONIMOS) {
    if (!contienePalabras(objetivo, termino)) continue;
    const hallado = equivalentes.find((e) => contienePalabras(f.texto, normalizarBusqueda(e)));
    if (hallado) return { calidad: "aproximada", motivo: `sinónimo: «${termino}» ≈ «${hallado}»` };
  }
  return undefined;
}

function evaluarValor(objetivo: number, toleranciaEur: number | undefined, valorFila: string): Evaluacion | undefined {
  // Una celda vacía o sin dígitos no es "0 €": parsearImporteCashflow la devuelve como 0 y casaría con importes pequeños.
  if (!/\d/.test(String(valorFila ?? ""))) return undefined;
  const cent = Math.round(Math.abs(parsearImporteCashflow(valorFila)) * 100);
  const buscado = Math.round(Math.abs(objetivo) * 100);
  if (!Number.isFinite(cent)) return undefined;
  if (cent === buscado) return { calidad: "exacta", motivo: "el importe coincide exactamente" };
  const tol = toleranciaCentimos(objetivo, toleranciaEur);
  if (montosCercanos(cent / 100, buscado / 100, tol / 100)) {
    const dif = Math.abs(cent - buscado) / 100;
    return { calidad: "aproximada", motivo: `importe cercano: difiere ${dif.toFixed(2)} € del buscado (tolerancia ±${(tol / 100).toFixed(2)} €)` };
  }
  return undefined;
}

interface Contexto {
  texto?: string;
  /** Texto que en realidad es un importe ("747"): vale por nombre O por importe. */
  valorDeTexto?: number;
  valor?: number;
  toleranciaEur?: number;
  categorias?: Set<DetalleCategoria>;
  seccionesDelTexto: Set<DetalleCategoria>;
  seccionesParciales: Set<DetalleCategoria>;
  semana?: string;
  empresa?: EmpresaTag;
  modo: ModoBusqueda;
}

type Estrategia = "directo" | "sinonimos";

interface Contenido {
  calidad: CalidadCoincidencia;
  motivos: string[];
  /** El nombre solo coincide por palabras parecidas. */
  debil: boolean;
}

/** Evalúa lo que el usuario pidió (nombre / importe) sobre una fila, exigiendo solo los criterios vigentes. */
function evaluarContenido(f: Fila, c: Contexto, exige: Set<Criterio>, estrategia: Estrategia): Contenido | undefined {
  const exigeTexto = exige.has("texto") && c.texto !== undefined;
  const exigeValor = exige.has("valor") && c.valor !== undefined;

  let porTexto: Evaluacion | undefined;
  if (exigeTexto) {
    if (estrategia === "sinonimos") porTexto = evaluarPorSinonimos(c.texto as string, f);
    else {
      porTexto = evaluarTexto(c.texto as string, f, c.modo);
      if (c.seccionesDelTexto.has(f.r.categoria)) {
        porTexto = { calidad: "exacta", motivo: `pertenece a la sección «${CATEGORIAS_CASHFLOW[f.r.categoria].titulo}»` };
      } else if ((!porTexto || porTexto.parecido) && c.seccionesParciales.has(f.r.categoria)) {
        // La sección nombrada en parte promueve a la fila por encima de un simple parecido de palabras.
        porTexto = { calidad: "aproximada", motivo: `el texto nombra la sección «${CATEGORIAS_CASHFLOW[f.r.categoria].titulo}»` };
      }
      if (!porTexto && c.valorDeTexto !== undefined) porTexto = evaluarValor(c.valorDeTexto, c.toleranciaEur, f.r.valor);
    }
  }
  const porValor = exigeValor ? evaluarValor(c.valor as number, c.toleranciaEur, f.r.valor) : undefined;

  if (exigeTexto && !porTexto) return undefined;
  if (exigeValor && !porValor) return undefined;

  const evs = [porTexto, porValor].filter((e): e is Evaluacion => Boolean(e));
  return {
    calidad: estrategia === "sinonimos" || evs.some((e) => e.calidad === "aproximada") ? "aproximada" : "exacta",
    motivos: evs.map((e) => e.motivo),
    debil: porTexto?.parecido === true,
  };
}

function* combinaciones<T>(lista: T[], tamano: number, desde = 0, actual: T[] = []): Generator<T[]> {
  if (actual.length === tamano) {
    yield [...actual];
    return;
  }
  for (let i = desde; i < lista.length; i++) yield* combinaciones(lista, tamano, i + 1, [...actual, lista[i]]);
}

const ORDEN_RELAJACION: Criterio[] = ["semana", "empresa", "categoria", "valor", "texto"];

const NOMBRE_CRITERIO: Record<Criterio, string> = {
  semana: "la semana",
  empresa: "la empresa",
  categoria: "la sección",
  valor: "el importe",
  texto: "el nombre",
};

/** Describe lo que REALMENTE se probó en un intento (no una fórmula fija). */
function descripcionIntento(relajados: Criterio[], exige: Set<Criterio>, estrategias: Estrategia[], textoEsImporte: boolean): string {
  const base = relajados.length === 0 ? "con todos los criterios" : `sin exigir ${relajados.map((c) => NOMBRE_CRITERIO[c]).join(" ni ")}`;
  const que: string[] = [];
  if (exige.has("texto")) que.push(textoEsImporte ? "nombre o importe" : "nombre");
  if (exige.has("valor")) que.push("importe");
  if (exige.has("categoria")) que.push("sección");
  if (estrategias.includes("sinonimos")) que.push("sinónimos");
  return que.length > 0 ? `${base} (${que.join(", ")})` : base;
}

/** Exactas primero; los parecidos por palabras (evidencia más débil) solo acompañan si no hay ninguna exacta. */
function seleccionar(candidatas: CoincidenciaCashflow[], modo: ModoBusqueda): CoincidenciaCashflow[] {
  const exactas = candidatas.filter((c) => c.calidad === "exacta");
  if (exactas.length === 0) return candidatas;
  // En modo "concepto" (que suma importes) solo cuentan las exactas si las hay.
  return modo === "concepto" ? exactas : [...exactas, ...candidatas.filter((c) => c.calidad === "aproximada" && !c.debil)];
}

const esFuerte = (sel: CoincidenciaCashflow[]) => sel.some((c) => c.calidad === "exacta" || !c.debil);

/**
 * Ejecuta la consulta sobre registros ya leídos (función pura, sin red). Si con todas las pistas no hay
 * nada, las va relajando (semana, empresa, sección, importe, nombre; primero las combinaciones que quitan
 * menos) y devuelve la primera que da un resultado sólido, diciendo cuáles quitó. Un resultado que solo
 * coincide por palabras parecidas no detiene la búsqueda: si relajando una pista aparece una coincidencia
 * exacta, se devuelve esa (junto a los parecidos).
 */
export function consultarCashflow(
  registros: DetalleRegistro[],
  consultaEntrada: ConsultaCashflow,
  opciones: { modo?: ModoBusqueda } = {}
): ResultadoConsultaCashflow {
  const modo: ModoBusqueda = opciones.modo ?? "interactivo";
  const porCategoria: Record<string, number> = {};
  for (const c of TODAS_LAS_CATEGORIAS) porCategoria[c] = 0;
  for (const r of registros) porCategoria[r.categoria] = (porCategoria[r.categoria] ?? 0) + 1;
  const filas = registros.map(prepararFila);

  const textoOriginal = consultaEntrada.texto?.trim() || undefined;
  let texto = textoOriginal;
  let valor = consultaEntrada.valor !== undefined && Number.isFinite(consultaEntrada.valor) && consultaEntrada.valor !== 0 ? Math.abs(consultaEntrada.valor) : undefined;
  const toleranciaEur =
    consultaEntrada.toleranciaEur !== undefined && Number.isFinite(consultaEntrada.toleranciaEur) && consultaEntrada.toleranciaEur >= 0
      ? consultaEntrada.toleranciaEur
      : undefined;
  // "Providencia de apremio 747,31": nombre e importe juntos. Si luego hay que relajar el importe, se vuelve al texto original.
  let importeSeparadoDelTexto = false;
  if (modo === "interactivo" && texto && valor === undefined) {
    const separado = separarTextoEImporte(texto);
    if (separado.valor !== undefined) {
      texto = separado.texto;
      valor = Math.abs(separado.valor);
      importeSeparadoDelTexto = true;
    }
  }
  const semana = consultaEntrada.semana?.trim() ? normalizarSemana(consultaEntrada.semana) : undefined;

  const categoriaPedida = modo === "interactivo" ? consultaEntrada.categoria?.trim() ?? "" : "";
  const seccionesPedidas = categoriaPedida ? categoriasPorTitulo(categoriaPedida) : [];
  const categoriaNoReconocida = categoriaPedida && seccionesPedidas.length === 0 ? categoriaPedida : undefined;
  if (categoriaNoReconocida && !texto) texto = categoriaNoReconocida;

  const contextoPara = (textoEfectivo: string | undefined, valorEfectivo: number | undefined): Contexto => {
    const interactivoConTexto = modo === "interactivo" && textoEfectivo !== undefined;
    const esImporte = textoEfectivo !== undefined && importeDeTexto(textoEfectivo) !== undefined;
    return {
      texto: textoEfectivo,
      valorDeTexto: interactivoConTexto && esImporte ? importeDeTexto(textoEfectivo as string) : undefined,
      valor: valorEfectivo,
      toleranciaEur,
      categorias: seccionesPedidas.length > 0 ? new Set(seccionesPedidas) : undefined,
      seccionesDelTexto: new Set(interactivoConTexto && !esImporte ? categoriasPorTitulo(textoEfectivo as string, true) : []),
      seccionesParciales: new Set(interactivoConTexto && !esImporte ? seccionesPorPalabraDistintiva(textoEfectivo as string) : []),
      semana,
      empresa: consultaEntrada.empresa,
      modo,
    };
  };
  const contextoNormal = contextoPara(texto, valor);
  const contextoTextoOriginal = importeSeparadoDelTexto ? contextoPara(textoOriginal, undefined) : contextoNormal;
  const empresa = consultaEntrada.empresa;

  const presentes = new Set<Criterio>();
  if (semana) presentes.add("semana");
  if (empresa) presentes.add("empresa");
  if (contextoNormal.categorias) presentes.add("categoria");
  if (valor !== undefined) presentes.add("valor");
  if (texto !== undefined) presentes.add("texto");
  const hayContenido = presentes.has("texto") || presentes.has("valor") || presentes.has("categoria");
  const textoEsImporte = texto !== undefined && importeDeTexto(texto) !== undefined;

  const consultaEfectiva: ConsultaCashflow = {
    ...(semana ? { semana } : {}),
    ...(empresa ? { empresa } : {}),
    ...(texto !== undefined ? { texto } : {}),
    ...(valor !== undefined ? { valor } : {}),
    ...(toleranciaEur !== undefined ? { toleranciaEur } : {}),
    ...(seccionesPedidas.length > 0 ? { categoria: categoriaPedida } : {}),
  };

  // Conjuntos de criterios a relajar, de menos a más; cada uno debe dejar al menos una pista de contenido.
  const relajables = ORDEN_RELAJACION.filter((c) => presentes.has(c));
  const subconjuntos: Criterio[][] = [[]];
  if (hayContenido && modo === "interactivo") {
    for (let n = 1; n <= relajables.length; n++) {
      for (const sub of combinaciones(relajables, n)) {
        const quedan = ["texto", "valor", "categoria"].some((c) => presentes.has(c as Criterio) && !sub.includes(c as Criterio));
        if (quedan) subconjuntos.push(sub);
      }
    }
  }

  /** Todas las coincidencias de un intento (antes de elegir entre exactas y aproximadas). */
  const ejecutar = (exige: Set<Criterio>, ctx: Contexto): CoincidenciaCashflow[] => {
    const estrategias: Estrategia[] = modo === "interactivo" && exige.has("texto") ? ["directo", "sinonimos"] : ["directo"];
    const porRegistro = new Map<DetalleRegistro, CoincidenciaCashflow>();
    const contenidoExigido = exige.has("texto") || exige.has("valor");
    const contenidoPedido = presentes.has("texto") || presentes.has("valor");

    for (const estrategia of estrategias) {
      for (const f of filas) {
        const previa = porRegistro.get(f.r);
        if (previa && !previa.debil) continue;
        if (exige.has("semana") && semana && normalizarSemana(f.r.semana) !== semana) continue;
        if (exige.has("categoria") && ctx.categorias && !ctx.categorias.has(f.r.categoria)) continue;

        let contenido: Contenido | undefined;
        if (!hayContenido) contenido = { calidad: "exacta", motivos: [], debil: false };
        else if (!contenidoExigido && contenidoPedido) {
          // Se relajaron nombre e importe: solo queda la sección; se dice claramente que no es una coincidencia de lo pedido.
          contenido = { calidad: "aproximada", motivos: ["no coincide lo buscado (nombre/importe); solo pertenece a la sección pedida"], debil: false };
        } else contenido = evaluarContenido(f, ctx, exige, estrategia);
        if (!contenido) continue;

        const { atribucion, empresaPorNombre: porNombre } = atribuir(f, empresa);
        if (empresa && exige.has("empresa") && atribucion === "otra") continue;
        // Un parecido débil previo no bloquea que un sinónimo real (no débil) promueva la fila.
        if (previa && contenido.debil) continue;
        porRegistro.set(f.r, { registro: f.r, calidad: contenido.calidad, motivos: contenido.motivos, atribucion, empresaPorNombre: porNombre, debil: contenido.debil });
      }
    }
    return [...porRegistro.values()];
  };

  const intentos: Array<{ descripcion: string; filas: number }> = [];

  const construir = (coincidencias: CoincidenciaCashflow[], relajados: Criterio[], exige: Set<Criterio>): ResultadoConsultaCashflow => {
    // Filas que el filtro de empresa apartó: se calculan sobre el intento ganador, con la misma selección, restando lo mostrado.
    let apartadas: ApartadaPorEmpresa[] = [];
    if (empresa && exige.has("empresa")) {
      const sinEmpresa = new Set(exige);
      sinEmpresa.delete("empresa");
      const mostradas = new Set(coincidencias.map((c) => c.registro));
      apartadas = seleccionar(ejecutar(sinEmpresa, relajados.includes("valor") ? contextoTextoOriginal : contextoNormal), modo)
        .filter((c) => c.atribucion === "otra" && !mostradas.has(c.registro))
        .map((c) => ({ nombre: c.registro.cliente ?? c.registro.concepto ?? "(sin nombre)", semana: c.registro.semana, valor: c.registro.valor }));
    }
    const reconocidas = [
      ...(relajados.includes("categoria") ? [] : seccionesPedidas),
      ...(relajados.includes("texto") ? [] : [...contextoNormal.seccionesDelTexto]),
    ];
    return {
      coincidencias,
      aproximado: coincidencias.length > 0 && coincidencias.every((c) => c.calidad === "aproximada"),
      filtrosRelajados: relajados,
      apartadasPorEmpresa: apartadas,
      intentos,
      totalRegistros: registros.length,
      porCategoria,
      categoriasReconocidas: [...new Set(reconocidas)],
      ...(categoriaNoReconocida ? { categoriaNoReconocida } : {}),
      consultaEfectiva,
    };
  };

  let respaldoDebil: { sel: CoincidenciaCashflow[]; relajados: Criterio[]; exige: Set<Criterio> } | undefined;
  for (const relajados of subconjuntos) {
    const exige = new Set<Criterio>([...presentes].filter((c) => !relajados.includes(c)));
    const ctx = relajados.includes("valor") ? contextoTextoOriginal : contextoNormal;
    const estrategias: Estrategia[] = modo === "interactivo" && exige.has("texto") ? ["directo", "sinonimos"] : ["directo"];
    const sel = seleccionar(ejecutar(exige, ctx), modo);
    intentos.push({ descripcion: descripcionIntento(relajados, exige, estrategias, textoEsImporte), filas: sel.length });
    if (sel.length === 0) continue;
    if (modo === "concepto") return construir(sel, relajados, exige);
    if (esFuerte(sel)) {
      // Lo que ya había (parecidos débiles de un intento anterior) acompaña a lo nuevo, sin duplicar.
      const propias = new Set(sel.map((c) => c.registro));
      const junto = respaldoDebil ? [...sel, ...respaldoDebil.sel.filter((c) => !propias.has(c.registro))] : sel;
      return construir(junto, relajados, exige);
    }
    respaldoDebil ??= { sel, relajados, exige };
  }
  if (respaldoDebil) return construir(respaldoDebil.sel, respaldoDebil.relajados, respaldoDebil.exige);
  return construir([], [], new Set(presentes));
}

function etiquetaEmpresa(c: CoincidenciaCashflow): string {
  if (c.registro.empresa) return c.atribucion === "otra" ? ` [${c.registro.empresa} — otra empresa]` : ` [${c.registro.empresa}]`;
  if (c.atribucion === "inferida_por_nombre") return ` [${c.empresaPorNombre} por el nombre]`;
  if (c.atribucion === "otra") return ` [el nombre indica ${c.empresaPorNombre}]`;
  return " [sin empresa]";
}

export function describirConsulta(consulta: ConsultaCashflow): string {
  const partes: string[] = [];
  if (consulta.texto?.trim()) partes.push(`texto «${consulta.texto.trim()}»`);
  if (consulta.valor !== undefined) partes.push(`importe ${consulta.valor}`);
  if (consulta.categoria?.trim()) partes.push(`sección «${consulta.categoria.trim()}»`);
  if (consulta.empresa) partes.push(`empresa ${consulta.empresa}`);
  if (consulta.semana) partes.push(`semana ${consulta.semana}`);
  return partes.length > 0 ? partes.join(", ") : "sin filtros";
}

export interface ExtrasFormato {
  /** Problemas que expuso la última lectura fresca de la hoja (filas no interpretadas, secciones no localizadas). */
  problemasLectura?: ProblemaEstructuraDatos[];
  /** Parámetros de la llamada que no eran válidos y se ignoraron. */
  ignorados?: string[];
}

function bloqueAfectado(problema: ProblemaEstructuraDatos, categorias: Set<string>): boolean {
  return categorias.has(problema.bloque);
}

/** Texto para el modelo: coincidencias con su porqué, avisos de filtros relajados y, si no hay nada, lo que de verdad se probó. */
export function formatearResultadoCashflow(
  resultado: ResultadoConsultaCashflow,
  consultaOriginal: ConsultaCashflow,
  extras: ExtrasFormato = {}
): string {
  const consulta = resultado.consultaEfectiva;
  const filtrada = Boolean(consulta.empresa);
  const problemas = extras.problemasLectura ?? [];
  const severos = problemas.filter(esProblemaEstructuraSevero);
  const deFila = problemas.filter((p) => !esProblemaEstructuraSevero(p));
  const categoriasRelevantes = new Set<string>([
    ...resultado.categoriasReconocidas,
    ...resultado.coincidencias.map((c) => c.registro.categoria),
  ]);
  const vacio = resultado.coincidencias.length === 0;

  const avisos: string[] = [];
  if ((extras.ignorados ?? []).length > 0) {
    avisos.push(`⚠️ Se ignoraron parámetros no válidos (la búsqueda NO está filtrada por ellos): ${(extras.ignorados ?? []).join("; ")}.`);
  }
  if (severos.length > 0) {
    avisos.push(
      "⚠️ LECTURA INCOMPLETA DE LA HOJA — hay secciones que no se pudieron localizar; lo que falte aquí puede estar en la hoja:\n" +
        severos.slice(0, 5).map((p) => `  • [${p.bloque}] ${p.detalle}`).join("\n")
    );
  }
  const filasRelevantes = vacio ? deFila : deFila.filter((p) => bloqueAfectado(p, categoriasRelevantes));
  if (filasRelevantes.length > 0) {
    avisos.push(
      "⚠️ Avisos de lectura de la hoja (las filas que WOBI no pudo interpretar NO aparecen en ninguna búsqueda; si el usuario dice que el dato existe, puede estar ahí):\n" +
        filasRelevantes.slice(0, 6).map((p) => `  • [${p.bloque}] ${p.detalle}`).join("\n") +
        (filasRelevantes.length > 6 ? `\n  … y ${filasRelevantes.length - 6} más.` : "")
    );
  }

  if (resultado.totalRegistros === 0) {
    return [
      ...avisos,
      "⚠️ La lectura de la hoja DATOS devolvió 0 movimientos: la pestaña está vacía o su estructura no se reconoció. " +
        "Es un fallo de lectura, NO una ausencia del dato — no concluyas nada sobre el pago y avisa al usuario.",
    ].join("\n\n");
  }

  const avisoCategoria = resultado.categoriaNoReconocida
    ? consultaOriginal.texto?.trim()
      ? `⚠️ «${resultado.categoriaNoReconocida}» no coincide con ninguna de las 10 secciones; se ignoró y se buscó solo por el texto.`
      : `⚠️ «${resultado.categoriaNoReconocida}» no coincide con ninguna de las 10 secciones (${TODAS_LAS_CATEGORIAS.map((c) => CATEGORIAS_CASHFLOW[c].titulo).join(", ")}); se buscó como nombre.`
    : "";

  if (vacio) {
    const cobertura = TODAS_LAS_CATEGORIAS.map((c) => {
      const n = resultado.porCategoria[c] ?? 0;
      const noLocalizada = severos.some((p) => p.bloque === c);
      return `${CATEGORIAS_CASHFLOW[c].titulo}: ${n}${n === 0 ? (noLocalizada ? " (NO SE PUDO LOCALIZAR)" : " (vacía)") : ""}`;
    }).join("; ");
    const MAX_INTENTOS_MOSTRADOS = 8;
    const intentos =
      resultado.intentos.slice(0, MAX_INTENTOS_MOSTRADOS).map((i, n) => `${n + 1}) ${i.descripcion}: ${i.filas} filas`).join("; ") +
      (resultado.intentos.length > MAX_INTENTOS_MOSTRADOS
        ? `; … y ${resultado.intentos.length - MAX_INTENTOS_MOSTRADOS} intentos más quitando más pistas (todos con 0 filas)`
        : "");
    return [
      ...avisos,
      `No se encontraron movimientos para: ${describirConsulta(consulta)}.`,
      avisoCategoria,
      `Se probó, en este orden: ${intentos}.`,
      `Cobertura: ${resultado.totalRegistros} movimientos leídos ahora de la hoja DATOS (${cobertura}).`,
      "No afirmes que el pago no está en el cashflow: di exactamente qué se buscó y pide al usuario el nombre exacto, el importe o la " +
        "sección donde lo ve; con ese dato vuelve a buscar (nombre, valor o categoria).",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (avisoCategoria) avisos.push(avisoCategoria);
  if (resultado.filtrosRelajados.length > 0) {
    avisos.push(
      `⚠️ No hay coincidencias exigiendo ${resultado.filtrosRelajados.map((f) => NOMBRE_CRITERIO[f]).join(" y ")}; ` +
        "estas aparecen sin exigirlo — díselo así al usuario y compara con lo que él dijo."
    );
  }
  if (resultado.aproximado) {
    avisos.push(`⚠️ COINCIDENCIA APROXIMADA (no hay ninguna exacta para ${describirConsulta(consulta)}) — confírmala con el usuario antes de darla por hecha.`);
  }
  const sinEmpresa = resultado.coincidencias.filter((c) => c.atribucion === "sin_empresa").length;
  if (sinEmpresa > 0) {
    avisos.push(
      `ℹ️ ${sinEmpresa} fila(s) figuran «sin empresa»: la tabla no tiene columna EMPRESA (Impuestos por Pagar, Aplazamientos, Gastos Fijos, ` +
        "Gastos Consultores) o la celda está vacía o con otra etiqueta. La hoja no dice de qué empresa son: no lo afirmes" +
        (filtrada ? ` (se muestran aunque se pidió ${consulta.empresa}).` : ".")
    );
  }
  if (resultado.apartadasPorEmpresa.length > 0) {
    const ejemplos = resultado.apartadasPorEmpresa.slice(0, 4).map((a) => `${a.nombre} (${a.semana || "sin semana"}, ${a.valor})`).join("; ");
    avisos.push(
      `ℹ️ ${resultado.apartadasPorEmpresa.length} coincidencia(s) más pertenecen, según la hoja o su nombre, a la OTRA empresa y no se muestran por el filtro ${consulta.empresa}: ${ejemplos}.`
    );
  }
  if (resultado.categoriasReconocidas.length > 0) {
    avisos.push(`Sección(es): ${resultado.categoriasReconocidas.map((c) => CATEGORIAS_CASHFLOW[c].titulo).join(", ")}.`);
  }

  const total = resultado.coincidencias.length;
  const mostradas = resultado.coincidencias.slice(0, LIMITE_LINEAS_CASHFLOW);
  const lineas = mostradas
    .map((c) => {
      const r = c.registro;
      const nombre = r.cliente ?? r.concepto ?? "(sin nombre)";
      const proyecto = r.proyecto ? ` / ${r.proyecto}` : "";
      const banco = r.banco ? ` (${r.banco})` : "";
      const anio = r.anio ? ` · año ${r.anio}` : "";
      const porque = c.motivos.length > 0 ? ` ⟵ ${c.motivos.join("; ")}` : "";
      return `[${r.categoria}]${etiquetaEmpresa(c)} ${nombre}${proyecto} — ${r.semana || "(sin semana)"} — ${r.valor}${banco}${anio}${porque}`;
    })
    .join("\n");

  const resumenSecciones = (() => {
    const cuenta: Record<string, number> = {};
    for (const c of resultado.coincidencias) cuenta[c.registro.categoria] = (cuenta[c.registro.categoria] ?? 0) + 1;
    return Object.entries(cuenta).map(([k, n]) => `${CATEGORIAS_CASHFLOW[k as DetalleCategoria]?.titulo ?? k}: ${n}`).join(", ");
  })();
  const recorte =
    total > LIMITE_LINEAS_CASHFLOW
      ? `\n… Mostrando ${LIMITE_LINEAS_CASHFLOW} de ${total} (${resumenSecciones}). Acota con contraparte, categoria, semana o valor; no copies el listado completo, resúmelo.`
      : "";

  return [...avisos, lineas + recorte].filter(Boolean).join("\n\n");
}

export interface EntradaConsultaValida {
  consulta?: ConsultaCashflow;
  ignorados: string[];
  /** Si la consulta no se puede ejecutar (p. ej. Footprint), el texto que se devuelve tal cual. */
  rechazo?: string;
}

/**
 * Convierte la entrada cruda de la herramienta en una consulta, SIN descartar nada en silencio: lo que no es
 * válido se enumera en `ignorados`, y si no queda ninguna pista válida se pide aclaración en vez de volcar la hoja.
 */
const MAX_CARACTERES_TEXTO = 200;

export function parsearEntradaConsulta(entrada: unknown): EntradaConsultaValida {
  const input = (entrada && typeof entrada === "object" && !Array.isArray(entrada) ? entrada : {}) as Record<string, unknown>;
  const ignorados: string[] = [];
  const consulta: ConsultaCashflow = {};

  /** Texto de un parámetro: acepta cadenas y números; cualquier otro tipo presente se enumera como ignorado. */
  const cadena = (nombre: string, limite = MAX_CARACTERES_TEXTO): string | undefined => {
    const v = input[nombre];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string" && typeof v !== "number") {
      ignorados.push(`${nombre} (se esperaba texto, llegó ${Array.isArray(v) ? "una lista" : typeof v})`);
      return undefined;
    }
    const t = String(v).trim();
    if (!t) return undefined;
    if (t.length > limite) {
      ignorados.push(`${nombre} (demasiado largo: se usaron los primeros ${limite} caracteres)`);
      return t.slice(0, limite);
    }
    return t;
  };

  const empresaCruda = cadena("empresa", 60);
  if (empresaCruda) {
    const e = empresaCruda.toUpperCase();
    if (e.includes("FOOTPRINT")) {
      return {
        ignorados,
        rechazo:
          "Footprint NO tiene cashflow en la hoja de Sheets (esta hoja es solo de WOBA y EWORKS). Para Footprint consulta Holded; " +
          "no mezcles sus movimientos con este cashflow.",
      };
    }
    const w = /\bWOBA\b/.test(e);
    const ew = /\bEWORKS\b/.test(e);
    if (ew && !w) consulta.empresa = "EWORKS";
    else if (w && !ew) consulta.empresa = "WOBA";
    else ignorados.push(`empresa «${empresaCruda}» (solo WOBA o EWORKS)`);
  }

  const semanaCruda = cadena("semana", 30);
  if (semanaCruda) {
    if (esSemanaValida(semanaCruda)) consulta.semana = normalizarSemana(semanaCruda);
    else ignorados.push(`semana «${semanaCruda}» (formato esperado: S38)`);
  }

  const texto = cadena("contraparte");
  if (texto) consulta.texto = texto;
  const categoria = cadena("categoria");
  if (categoria) consulta.categoria = categoria;

  if (input.valor !== undefined && input.valor !== null && input.valor !== "") {
    const crudo = input.valor;
    const numero =
      typeof crudo === "number" ? crudo : typeof crudo === "string" && importeDeTexto(crudo) !== undefined ? parsearImporteCashflow(crudo) : Number.NaN;
    if (Number.isFinite(numero) && Math.abs(numero) >= 0.01) consulta.valor = Math.abs(numero);
    else ignorados.push(`valor «${String(crudo).slice(0, 40)}» (no es un importe válido de al menos 0,01)`);
  }
  if (input.tolerancia_eur !== undefined && input.tolerancia_eur !== null) {
    const t = input.tolerancia_eur;
    if (typeof t === "number" && Number.isFinite(t) && t >= 0) consulta.toleranciaEur = t;
    else ignorados.push(`tolerancia_eur «${String(t).slice(0, 40)}» (debe ser un número ≥ 0)`);
  }

  const hayAlgunaPista = Boolean(consulta.empresa || consulta.semana || consulta.texto || consulta.categoria || consulta.valor !== undefined);
  if (!hayAlgunaPista && ignorados.length > 0) {
    return {
      ignorados,
      rechazo:
        `No se aplicó ningún filtro válido (${ignorados.join("; ")}). Pide al usuario un nombre, un importe, una sección, una semana o una empresa ` +
        "(WOBA o EWORKS) y vuelve a consultar; no vuelques toda la hoja.",
    };
  }
  return { consulta, ignorados };
}

export interface ResultadoBusquedaCashflow {
  coincidencias: DetalleRegistro[];
  /** true si NINGUNA coincidencia fue exacta (todas vinieron de coincidencias parecidas). */
  aproximado: boolean;
}

/**
 * Busca en TODA la hoja DATOS (todas las categorías) un concepto/proveedor por NOMBRE. Reutilizable por
 * otras herramientas (p. ej. consultar_proximas_alertas, que suma los importes encontrados) sin depender de
 * que el modelo encadene una llamada. Modo "concepto": nombre exacto o parecido, sin sinónimos, sin importes
 * ni secciones y sin relajar filtros — el mismo criterio conservador de siempre, pero sin distinguir tildes.
 */
export async function buscarEnCashflowPorConcepto(
  concepto: string,
  empresaFiltro?: EmpresaTag
): Promise<ResultadoBusquedaCashflow> {
  if (!concepto.trim()) return { coincidencias: [], aproximado: false };
  const registros = await fetchDetalleRegistros();
  const resultado = consultarCashflow(registros, { texto: concepto, empresa: empresaFiltro }, { modo: "concepto" });
  return { coincidencias: resultado.coincidencias.map((c) => c.registro), aproximado: resultado.aproximado };
}

import { fetchDetalleRegistros, type DetalleCategoria, type DetalleRegistro, type EmpresaTag } from "./cashflowSheet";
import { parsearImporteCashflow } from "../cashflow/cruceHoldedCashflow";
import { montosCercanos } from "../utils/montos";
import { palabrasParecidas, textosParecidos } from "../utils/textoParecido";

/**
 * Motor único de búsqueda sobre la hoja DATOS (las 10 categorías). Lo usan consultar_cashflow_detalle
 * y consultar_proximas_alertas.
 *
 * Caso real (2026-09-21, EWORKS): "Providencia de apremio" (S38, 747,31 €) y "Sanción AEAT" (S41,
 * 137,62 €) SÍ estaban en «Impuestos por Pagar», pero Wobi respondió que "NO están en el cashflow".
 * Causas, verificadas en vivo contra la hoja real:
 *  1. El filtro `empresa` descartaba TODA fila sin etiqueta de empresa — y Impuestos por Pagar (como
 *     Gastos Fijos, Pagos Extras o Aplazamientos) no tiene columna EMPRESA. Pedir "EWORKS" + "apremio"
 *     devolvía siempre vacío aunque la fila existiera. Ahora una fila sin empresa NO se descarta: se
 *     devuelve marcada "sin empresa en la hoja" (o con la empresa inferida por su nombre, p. ej.
 *     "MOD 303 EWORKS Q2"), y solo se aparta lo que la hoja o el nombre atribuyen a la OTRA empresa.
 *  2. No existía búsqueda por importe: "747" o "137" se comparaban con el texto, nunca con el valor.
 *  3. No existía búsqueda por el título de la sección ("Impuestos por Pagar", "Aplazamiento…").
 *  4. La comparación distinguía tildes ("sancion" no encontraba "Sanción") y no aceptaba sinónimos
 *     obvios (Hacienda ≈ AEAT).
 *  5. Un resultado vacío se presentaba como prueba de ausencia. Ahora, si los filtros dejan el
 *     resultado vacío, se relajan de uno en uno (semana, empresa) y se dice cuál se relajó; y si de
 *     verdad no hay nada, la respuesta detalla qué se revisó para que nadie lo dé por inexistente.
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
 * Sinónimos de uso común en la contabilidad del grupo. Solo se consultan cuando la búsqueda directa no
 * encuentra nada, y lo que se encuentra por esta vía siempre se marca como aproximado.
 */
const SINONIMOS: Array<{ termino: string; equivalentes: string[] }> = [
  // Los modelos tributarios (MOD 111/115/303/200) son de la AEAT; "impuestos" a secas NO se usa: también
  // nombra la Seguridad Social ("Impuestos seg social") y arrastraría filas que no son de Hacienda.
  { termino: "hacienda", equivalentes: ["aeat", "tributaria", "providencia", "apremio", "sancion", "mod 111", "mod 115", "mod 200", "mod 303"] },
  { termino: "aeat", equivalentes: ["hacienda", "tributaria", "providencia", "apremio"] },
  { termino: "tributaria", equivalentes: ["aeat", "hacienda"] },
  { termino: "apremio", equivalentes: ["providencia", "sancion", "recargo"] },
  { termino: "providencia", equivalentes: ["apremio"] },
  { termino: "sancion", equivalentes: ["multa", "recargo", "apremio"] },
  { termino: "multa", equivalentes: ["sancion"] },
  { termino: "iva", equivalentes: ["mod 303", "303"] },
  { termino: "irpf", equivalentes: ["mod 111", "mod 115", "retenciones"] },
  { termino: "retenciones", equivalentes: ["mod 111", "mod 115", "irpf"] },
  { termino: "seguridad social", equivalentes: ["seg social", "tgss"] },
];

const PALABRAS_VACIAS = new Set([
  "de", "del", "la", "el", "los", "las", "por", "en", "y", "a", "al", "un", "una", "cashflow",
  "seccion", "zona", "area", "tabla", "categoria", "titulo",
]);

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

/** 'S3', 's03', '3' → 'S03'. */
export function normalizarSemana(semana: string): string {
  const m = String(semana ?? "").trim().match(/^s?\s*0*(\d{1,2})$/i);
  return m ? `S${m[1].padStart(2, "0")}` : String(semana ?? "").trim().toUpperCase();
}

function textoDeRegistro(r: DetalleRegistro): string {
  return normalizarBusqueda([r.cliente, r.proyecto, r.concepto, r.banco].filter(Boolean).join(" "));
}

const RE_IMPORTE = /^[€$£\s]*-?\d[\d.,]*\s*(?:€|eur|euros?)?\s*$/i;

/** Si el texto es en realidad un importe ("747", "747,31 €", "€137.62"), devuelve su valor. */
export function importeDeTexto(texto: string): number | undefined {
  if (!RE_IMPORTE.test(String(texto ?? ""))) return undefined;
  const valor = parsearImporteCashflow(texto);
  return Number.isFinite(valor) && valor !== 0 ? valor : undefined;
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

export type AtribucionEmpresa = "confirmada" | "inferida_por_nombre" | "sin_empresa";
export type CalidadCoincidencia = "exacta" | "aproximada";
export type FiltroRelajado = "semana" | "empresa";

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
}

export interface ResultadoConsultaCashflow {
  coincidencias: CoincidenciaCashflow[];
  /** true si hay coincidencias y NINGUNA es exacta. */
  aproximado: boolean;
  /** Filtros que hubo que quitar para encontrar algo. */
  filtrosRelajados: FiltroRelajado[];
  /** Filas que el filtro de empresa apartó por pertenecer, según la hoja o su nombre, a la otra empresa. */
  apartadasPorEmpresa: number;
  totalRegistros: number;
  porCategoria: Record<string, number>;
  /** Secciones reconocidas por el texto o por `categoria` (si las hubo). */
  categoriasReconocidas: DetalleCategoria[];
  /** `categoria` que no coincide con ninguna sección: se buscó como nombre. */
  categoriaNoReconocida?: string;
}

function atribuir(r: DetalleRegistro, empresa: EmpresaTag): AtribucionEmpresa | "otra" {
  if (r.empresa) return r.empresa === empresa ? "confirmada" : "otra";
  const texto = textoDeRegistro(r);
  const otra: EmpresaTag = empresa === "WOBA" ? "EWORKS" : "WOBA";
  if (texto.includes(empresa.toLowerCase())) return "inferida_por_nombre";
  if (texto.includes(otra.toLowerCase())) return "otra";
  return "sin_empresa";
}

function toleranciaPorDefecto(valor: number): number {
  return Math.min(5, Math.max(1, Math.abs(valor) * 0.005));
}

interface Evaluacion {
  calidad: CalidadCoincidencia;
  motivo: string;
}

function evaluarTexto(consulta: string, textoFila: string): Evaluacion | undefined {
  const objetivo = normalizarBusqueda(consulta);
  if (!objetivo) return undefined;
  if (textoFila.includes(objetivo)) return { calidad: "exacta", motivo: `el nombre contiene «${consulta.trim()}»` };

  const palabras = palabrasSignificativas(consulta);
  const filaPalabras = textoFila.split(" ").filter(Boolean);
  if (palabras.length > 1 && palabras.every((p) => textoFila.includes(p) || filaPalabras.some((f) => palabrasParecidas(p, f)))) {
    return { calidad: "exacta", motivo: `el nombre contiene todas las palabras de «${consulta.trim()}»` };
  }
  if (textosParecidos(consulta, textoFila)) return { calidad: "aproximada", motivo: "el nombre es parecido (palabras similares)" };
  return undefined;
}

function evaluarPorSinonimos(consulta: string, textoFila: string): Evaluacion | undefined {
  const objetivo = normalizarBusqueda(consulta);
  for (const { termino, equivalentes } of SINONIMOS) {
    if (!objetivo.includes(termino)) continue;
    const hallado = equivalentes.find((e) => textoFila.includes(normalizarBusqueda(e)));
    if (hallado) return { calidad: "aproximada", motivo: `sinónimo: «${termino}» ≈ «${hallado}»` };
  }
  return undefined;
}

function evaluarValor(objetivo: number, tolerancia: number | undefined, valorFila: string): Evaluacion | undefined {
  const valor = Math.abs(parsearImporteCashflow(valorFila));
  const buscado = Math.abs(objetivo);
  if (!Number.isFinite(valor)) return undefined;
  if (Math.round(valor * 100) === Math.round(buscado * 100)) return { calidad: "exacta", motivo: "el importe coincide exactamente" };
  const tol = tolerancia ?? toleranciaPorDefecto(buscado);
  if (montosCercanos(valor, buscado, tol)) {
    return { calidad: "aproximada", motivo: `importe cercano (±${tol.toFixed(2).replace(/\.00$/, "")} €)` };
  }
  return undefined;
}

interface Pasada {
  semana: boolean;
  empresa: boolean;
}

type Modo = "directo" | "sinonimos" | "seccion";

function evaluarPasada(
  registros: DetalleRegistro[],
  consulta: ConsultaCashflow,
  pasada: Pasada,
  categorias: Set<DetalleCategoria> | undefined,
  modo: Modo
): { coincidencias: CoincidenciaCashflow[]; apartadas: number } {
  const coincidencias: CoincidenciaCashflow[] = [];
  let apartadas = 0;
  const texto = consulta.texto?.trim();
  const valorDeTexto = texto ? importeDeTexto(texto) : undefined;
  const valorBuscado = consulta.valor !== undefined && Number.isFinite(consulta.valor) ? consulta.valor : undefined;
  const hayContenido = Boolean(texto) || valorBuscado !== undefined;

  for (const r of registros) {
    if (pasada.semana && consulta.semana && normalizarSemana(r.semana) !== normalizarSemana(consulta.semana)) continue;
    if (categorias && !categorias.has(r.categoria)) continue;

    let atribucion: AtribucionEmpresa = r.empresa ? "confirmada" : "sin_empresa";
    if (pasada.empresa && consulta.empresa) {
      const a = atribuir(r, consulta.empresa);
      if (a === "otra") {
        apartadas++;
        continue;
      }
      atribucion = a;
    }

    const motivos: string[] = [];
    let calidad: CalidadCoincidencia = "exacta";

    if (modo === "seccion") {
      motivos.push(`pertenece a la sección «${CATEGORIAS_CASHFLOW[r.categoria].titulo}»`);
    } else if (hayContenido) {
      const filaTexto = textoDeRegistro(r);
      const porTexto = texto ? (modo === "sinonimos" ? evaluarPorSinonimos(texto, filaTexto) : evaluarTexto(texto, filaTexto)) : undefined;
      const porValorTexto = modo === "directo" && valorDeTexto !== undefined ? evaluarValor(valorDeTexto, consulta.toleranciaEur, r.valor) : undefined;
      const porValor = modo === "directo" && valorBuscado !== undefined ? evaluarValor(valorBuscado, consulta.toleranciaEur, r.valor) : undefined;

      // Texto Y valor explícitos se exigen a la vez; un texto que solo "parece" un importe vale por texto O por valor.
      const cumple =
        valorBuscado !== undefined && texto ? Boolean(porTexto || porValorTexto) && Boolean(porValor) : Boolean(porTexto || porValorTexto || porValor);
      if (!cumple) continue;
      for (const ev of [porTexto, porValorTexto, porValor]) {
        if (!ev) continue;
        motivos.push(ev.motivo);
        if (ev.calidad === "aproximada") calidad = "aproximada";
      }
      if (modo === "sinonimos") calidad = "aproximada";
    }

    coincidencias.push({ registro: r, calidad, motivos, atribucion });
  }
  return { coincidencias, apartadas };
}

/**
 * Ejecuta la consulta sobre registros ya leídos (función pura, sin red). Orden de estrategias:
 * búsqueda directa (nombre / importe) → sinónimos → sección por título. En cada una, si los filtros de
 * semana/empresa dejan el resultado vacío se relajan de uno en uno y se informa de cuál.
 */
export function consultarCashflow(registros: DetalleRegistro[], consulta: ConsultaCashflow): ResultadoConsultaCashflow {
  const porCategoria: Record<string, number> = {};
  for (const c of TODAS_LAS_CATEGORIAS) porCategoria[c] = 0;
  for (const r of registros) porCategoria[r.categoria] = (porCategoria[r.categoria] ?? 0) + 1;

  const texto = consulta.texto?.trim() ?? "";
  const categoriaPedida = consulta.categoria?.trim() ?? "";
  const seccionesPedidas = categoriaPedida ? categoriasPorTitulo(categoriaPedida) : [];
  const categoriaNoReconocida = categoriaPedida && seccionesPedidas.length === 0 ? categoriaPedida : undefined;
  // Un texto que ES el título de una sección ("impuestos por pagar") equivale a pedir esa sección.
  const seccionesDelTexto = !categoriaPedida && texto && importeDeTexto(texto) === undefined ? categoriasPorTitulo(texto, true) : [];

  let consultaEfectiva: ConsultaCashflow = { ...consulta };
  if (categoriaNoReconocida && !texto) consultaEfectiva = { ...consultaEfectiva, texto: categoriaNoReconocida };
  if (seccionesDelTexto.length > 0) consultaEfectiva = { ...consultaEfectiva, texto: undefined };

  const categorias =
    seccionesPedidas.length > 0 ? new Set(seccionesPedidas) : seccionesDelTexto.length > 0 ? new Set(seccionesDelTexto) : undefined;
  const reconocidas = [...(categorias ?? [])];

  const hayContenido = Boolean(consultaEfectiva.texto?.trim()) || consulta.valor !== undefined;
  const pasadas: Pasada[] =
    hayContenido || categorias
      ? [
          { semana: true, empresa: true },
          { semana: false, empresa: true },
          { semana: true, empresa: false },
          { semana: false, empresa: false },
        ]
      : [{ semana: true, empresa: true }];

  const construir = (coincidencias: CoincidenciaCashflow[], pasada: Pasada, apartadas: number, secciones: DetalleCategoria[]): ResultadoConsultaCashflow => {
    const relajados: FiltroRelajado[] = [];
    if (consulta.semana && !pasada.semana) relajados.push("semana");
    if (consulta.empresa && !pasada.empresa) relajados.push("empresa");
    return {
      coincidencias,
      aproximado: coincidencias.length > 0 && coincidencias.every((c) => c.calidad === "aproximada"),
      filtrosRelajados: relajados,
      apartadasPorEmpresa: apartadas,
      totalRegistros: registros.length,
      porCategoria,
      categoriasReconocidas: secciones,
      ...(categoriaNoReconocida ? { categoriaNoReconocida } : {}),
    };
  };

  const modos: Modo[] = ["directo"];
  if (consultaEfectiva.texto?.trim() && consulta.valor === undefined && !categorias) modos.push("sinonimos");

  let apartadasEstricta = 0;
  for (const modo of modos) {
    for (const [i, pasada] of pasadas.entries()) {
      const { coincidencias, apartadas } = evaluarPasada(registros, consultaEfectiva, pasada, categorias, modo);
      if (modo === "directo" && i === 0) apartadasEstricta = apartadas;
      if (coincidencias.length === 0) continue;
      // Solo las exactas si las hay; las aproximadas únicamente cuando no existe ninguna exacta.
      const exactas = coincidencias.filter((c) => c.calidad === "exacta");
      return construir(exactas.length > 0 ? exactas : coincidencias, pasada, i === 0 ? apartadas : apartadasEstricta, reconocidas);
    }
  }

  // Último recurso: el texto nombra en parte el título de una sección → se devuelve esa sección entera.
  if (texto && !categorias && consulta.valor === undefined && importeDeTexto(texto) === undefined && palabrasSignificativas(texto).length >= 2) {
    const porTitulo = categoriasPorTitulo(texto);
    if (porTitulo.length > 0) {
      for (const pasada of pasadas) {
        const { coincidencias } = evaluarPasada(registros, { ...consulta, texto: undefined }, pasada, new Set(porTitulo), "seccion");
        if (coincidencias.length > 0) return construir(coincidencias, pasada, apartadasEstricta, porTitulo);
      }
    }
  }

  return construir([], pasadas[0], apartadasEstricta, reconocidas);
}

function etiquetaEmpresa(c: CoincidenciaCashflow, filtrada: boolean): string {
  if (c.registro.empresa) return ` [${c.registro.empresa}]`;
  if (!filtrada) return "";
  return c.atribucion === "inferida_por_nombre" ? " [empresa inferida por el nombre]" : " [sin empresa en la hoja]";
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

/** Texto para el modelo: coincidencias con su porqué, avisos de filtros relajados y, si no hay nada, la cobertura real. */
export function formatearResultadoCashflow(resultado: ResultadoConsultaCashflow, consulta: ConsultaCashflow): string {
  const filtrada = Boolean(consulta.empresa);
  const avisoCategoria = resultado.categoriaNoReconocida
    ? `⚠️ «${resultado.categoriaNoReconocida}» no coincide con ninguna de las 10 secciones (${TODAS_LAS_CATEGORIAS.map((c) => CATEGORIAS_CASHFLOW[c].titulo).join(", ")}); se buscó como nombre.`
    : "";

  if (resultado.coincidencias.length === 0) {
    const cobertura = TODAS_LAS_CATEGORIAS.map((c) => {
      const n = resultado.porCategoria[c] ?? 0;
      return `${CATEGORIAS_CASHFLOW[c].titulo}: ${n}${n === 0 ? " (SIN FILAS — revisar la estructura)" : ""}`;
    }).join("; ");
    return [
      `No se encontraron movimientos para: ${describirConsulta(consulta)}.`,
      avisoCategoria,
      `Cobertura de esta búsqueda: ${resultado.totalRegistros} movimientos leídos ahora de la hoja DATOS (${cobertura}). ` +
        "Se probó por nombre (sin tildes, por palabras y por sinónimos), por importe cercano y por título de sección, " +
        "y también sin los filtros de semana y empresa que se hubieran indicado.",
      "No afirmes que el pago no está en el cashflow: di exactamente qué se buscó y, si el usuario indica en qué sección " +
        "o con qué importe está, vuelve a buscar con 'categoria' o 'valor'.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const avisos: string[] = [];
  if (avisoCategoria) avisos.push(avisoCategoria);
  if (resultado.filtrosRelajados.length > 0) {
    avisos.push(
      `⚠️ No hay coincidencias respetando ${resultado.filtrosRelajados.map((f) => `el filtro de ${f}`).join(" y ")}; ` +
        "estas aparecen al quitarlo — díselo así al usuario."
    );
  }
  if (resultado.aproximado) {
    avisos.push(
      `⚠️ COINCIDENCIA APROXIMADA (no hay ninguna exacta para ${describirConsulta(consulta)}) — confírmala con el usuario antes de darla por hecha.`
    );
  }
  if (filtrada && resultado.coincidencias.some((c) => !c.registro.empresa)) {
    avisos.push(
      "ℹ️ Algunas filas no tienen columna EMPRESA en la hoja (p. ej. Impuestos por Pagar): se muestran igualmente; " +
        `no se sabe si son de ${consulta.empresa} o de la otra empresa — no lo afirmes.`
    );
  }
  if (resultado.categoriasReconocidas.length > 0) {
    avisos.push(`Sección(es): ${resultado.categoriasReconocidas.map((c) => CATEGORIAS_CASHFLOW[c].titulo).join(", ")}.`);
  }

  const lineas = resultado.coincidencias
    .map((c) => {
      const r = c.registro;
      const nombre = r.cliente ?? r.concepto ?? "(sin nombre)";
      const proyecto = r.proyecto ? ` / ${r.proyecto}` : "";
      const banco = r.banco ? ` (${r.banco})` : "";
      const anio = r.anio ? ` · año ${r.anio}` : "";
      const porque = c.motivos.length > 0 ? ` ⟵ ${c.motivos.join("; ")}` : "";
      return `[${r.categoria}]${etiquetaEmpresa(c, filtrada)} ${nombre}${proyecto} — ${r.semana || "(sin semana)"} — ${r.valor}${banco}${anio}${porque}`;
    })
    .join("\n");

  return [...avisos, lineas].filter(Boolean).join("\n\n");
}

export interface ResultadoBusquedaCashflow {
  coincidencias: DetalleRegistro[];
  /** true si NINGUNA coincidencia fue exacta (todas vinieron de coincidencias parecidas, por sinónimo o por importe cercano). */
  aproximado: boolean;
}

/**
 * Busca en TODA la hoja DATOS (todas las categorías) un concepto/proveedor. Reutilizable por otras
 * herramientas (p. ej. consultar_proximas_alertas) sin depender de que el modelo encadene una llamada.
 */
export async function buscarEnCashflowPorConcepto(
  concepto: string,
  empresaFiltro?: EmpresaTag
): Promise<ResultadoBusquedaCashflow> {
  if (!concepto.trim()) return { coincidencias: [], aproximado: false };
  const registros = await fetchDetalleRegistros();
  const resultado = consultarCashflow(registros, { texto: concepto, empresa: empresaFiltro });
  return { coincidencias: resultado.coincidencias.map((c) => c.registro), aproximado: resultado.aproximado };
}

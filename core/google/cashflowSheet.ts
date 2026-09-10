import { getSheetsClient } from "./sheetsClient";
import { CacheLectura, type LecturaConMeta } from "../utils/readCache";
import { enteroAcotado } from "../utils/asyncTimeout";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;

// Hoja CASHFLOW: fila 5 = semanas (headers), 6 = balance inicial, 7 = income,
// 8 = project expenses, 9 = general expenses, 10 = diferencias (no usada), 11 = balance final.
const RESUMEN_RANGE = "CASHFLOW!C5:ZZ11";

export interface ResumenSemana {
  semana: string;
  balanceInicial: string;
  income: string;
  projectExpenses: string;
  generalExpenses: string;
  balanceFinal: string;
}

function assertSheetId(): string {
  if (!CASHFLOW_SHEET_ID) {
    throw new Error("Falta la variable de entorno CASHFLOW_SHEET_ID.");
  }
  return CASHFLOW_SHEET_ID;
}

/**
 * Lee el resumen semanal ya calculado (valores, no fórmulas) de la hoja CASHFLOW.
 */
async function cargarResumenSemanas(): Promise<ResumenSemana[]> {
  const sheetId = assertSheetId();
  const sheets = getSheetsClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: RESUMEN_RANGE,
    valueRenderOption: "FORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  const [semanas = [], balanceInicial = [], income = [], projectExpenses = [], generalExpenses = [], , balanceFinal = []] =
    rows;

  const result: ResumenSemana[] = [];
  semanas.forEach((semana, i) => {
    if (!semana) return;
    result.push({
      semana: String(semana),
      balanceInicial: balanceInicial[i] ?? "",
      income: income[i] ?? "",
      projectExpenses: projectExpenses[i] ?? "",
      generalExpenses: generalExpenses[i] ?? "",
      balanceFinal: balanceFinal[i] ?? "",
    });
  });

  return result;
}

const CACHE_RESUMEN_TTL_MS = enteroAcotado(process.env.WOBI_CASHFLOW_CACHE_TTL_MS, 10_000, 0, 60_000);
const cacheResumen = new CacheLectura<ResumenSemana[]>("cashflow_resumen", CACHE_RESUMEN_TTL_MS);

export function fetchResumenSemanasConMeta(): Promise<LecturaConMeta<ResumenSemana[]>> {
  return cacheResumen.obtener(cargarResumenSemanas);
}

export async function fetchResumenSemanas(): Promise<ResumenSemana[]> {
  return (await fetchResumenSemanasConMeta()).datos;
}

export type DetalleCategoria =
  | "INGRESOS"
  | "PAGOS_PROYECTOS"
  | "PAGOS_EXTRAS"
  | "IMPUESTOS_POR_PAGAR"
  | "APLAZAMIENTO_IMPUESTOS"
  | "GASTOS_FIJOS"
  | "GASTOS_CONSULTORES_MES_ACTUAL"
  | "GASTOS_CONSULTORES_PROXIMO_MES"
  | "PAGOS_PENDIENTES_ALBERTO"
  | "DEUDAS_PENDIENTES";

export type EmpresaTag = "WOBA" | "EWORKS";

export interface DetalleRegistro {
  categoria: DetalleCategoria;
  cliente?: string;
  proyecto?: string;
  concepto?: string;
  semana: string;
  valor: string;
  /** Solo presente en GASTOS_FIJOS — banco desde el que se paga (columna L de DATOS). */
  banco?: string;
  /**
   * Solo presente en IMPUESTOS_POR_PAGAR, APLAZAMIENTO_IMPUESTOS, PAGOS_PENDIENTES_ALBERTO y
   * DEUDAS_PENDIENTES — columna AÑO de DATOS (columna X en Pendientes desde que Carlos la agregó,
   * ver hallazgo en parsearSeccionesPendientes).
   */
  anio?: string;
  /**
   * Empresa DUEÑA del movimiento (WOBA | EWORKS), leída de la columna de tag.
   * undefined cuando el bloque no tiene esa columna (Pagos Extras, Impuestos
   * por Pagar, Aplazamiento Impuestos, Gastos Fijos) — no debe confundirse
   * con el nombre del cliente/proveedor. Pendientes SÍ la tiene desde que
   * Carlos la agregó (columna W) — ver hallazgo en parsearSeccionesPendientes.
   */
  empresa?: EmpresaTag;
}

type DetalleField = "cliente" | "proyecto" | "concepto" | "semana" | "valor" | "empresa" | "banco";

interface DetalleBlock {
  categoria: DetalleCategoria;
  range: string;
  fields: DetalleField[];
}

// Bloques de columnas fijas de la hoja DATOS. Solo Ingresos y Pagos Proyectos
// tienen columna de tag de empresa dueña (F y R respectivamente); el resto no.
// GASTOS_FIJOS, GASTOS_CONSULTORES_MES_ACTUAL, GASTOS_CONSULTORES_PROXIMO_MES
// (columna I, tres secciones apiladas), PAGOS_PROYECTOS/IMPUESTOS_POR_PAGAR/
// APLAZAMIENTO_IMPUESTOS (columna N, tres apiladas) y PAGOS_PENDIENTES_
// ALBERTO/DEUDAS_PENDIENTES (columna X, dos apiladas) se parsean aparte más
// abajo porque no tienen un rango de filas fijo propio.
const DETALLE_BLOCKS: DetalleBlock[] = [
  { categoria: "INGRESOS", range: "DATOS!B6:F500", fields: ["cliente", "proyecto", "semana", "valor", "empresa"] },
  { categoria: "PAGOS_EXTRAS", range: "DATOS!T6:V500", fields: ["cliente", "semana", "valor"] },
];

// Hallazgo real de auditoría (2026-09-09, pedido explícito de Carlos de ser
// riguroso porque "a veces incluimos o quitamos filas o columnas y esto
// mueve las áreas"): esta sección REALMENTE ya no es X:Z. Verificado en vivo
// contra el Sheet real — Carlos agregó una columna EMPRESA (ahora en W) y una
// columna AÑO (ahora en X, con el título propio "AÑ0" — sí, con cero, typo
// real en la celda), lo que corrió CLIENTE a Z (antes en X) y SEMANA/VALOR a
// AA/AB (antes en Y/Z) — Y quedó como columna vacía/separadora. La versión
// anterior de este código seguía leyendo X:Z buscando el título en la
// columna X (ahora AÑO, nunca coincide con "PAGOS PENDIENTES ALBERTO"/"DEUDAS
// PENDIENTES OTROS") — categoriaActual nunca se activaba, así que CADA fila
// de esta sección se descartaba en silencio (`if (!categoriaActual) continue`)
// sin ningún error. Esto dejó invisible, en todas las lecturas del cashflow
// durante un tiempo indeterminado, dinero real: reintegros/salarios/préstamo
// de Alberto y deudas con Carrefour/Susana Iso/375LED/Ireri, sin que ninguna
// herramienta ni el propio chat lo notaran o avisaran — exactamente el tipo
// de corrupción silenciosa que Carlos pidió que dejara de pasar.
// Hallazgo real de auditoría xhigh: este rango terminaba en fila 300 mientras que el lado de
// ESCRITURA (cashflowWrite.ts, SECCION_RANGO_LECTURA) siempre escaneó hasta fila 500 buscando hueco
// libre — si DEUDAS_PENDIENTES (que no tiene límite estricto de crecimiento, ver comentario en
// encontrarFilaDisponibleEnSeccion) alguna vez creciera más allá de la fila 300, una fila nueva se
// escribiría bien pero nunca más volvería a leerse — el mismo tipo de "dinero real invisible sin
// ningún error" que motivó todo este fix, por otro camino. Se iguala a 500 para que lectura y
// escritura miren exactamente el mismo rango real.
const SECCION_PENDIENTES_RANGE = "DATOS!W1:AB500";
// Posiciones dentro de una fila de SECCION_PENDIENTES_RANGE (0-indexado): W=0 empresa, X=1 año, Y=2 (vacía), Z=3 cliente/título, AA=4 semana, AB=5 valor.
// Hallazgo real de auditoría xhigh: cashflowWrite.ts redeclaraba este mismo offset por su cuenta
// (SECCION_IDX_CLIENTE) — dos constantes independientes codificando el mismo hecho pueden desincronizarse
// si Carlos vuelve a mover estas columnas y solo se actualiza una. Se exporta para que ambos lados usen
// la MISMA fuente de verdad.
export const SECCION_IDX_CLIENTE_PENDIENTES = 3;
const TITULOS_SECCION_PENDIENTES: Record<string, DetalleCategoria> = {
  "PAGOS PENDIENTES ALBERTO": "PAGOS_PENDIENTES_ALBERTO",
  "DEUDAS PENDIENTES OTROS": "DEUDAS_PENDIENTES",
};

function parsearSeccionesPendientes(rows: string[][]): DetalleRegistro[] {
  const registros: DetalleRegistro[] = [];
  let categoriaActual: DetalleCategoria | null = null;

  for (const row of rows) {
    // W=empresa, X=año, Y=(vacía, separadora), Z=cliente, AA=semana, AB=valor — ver hallazgo arriba.
    const empresaRaw = String(row[0] ?? "").trim().toUpperCase();
    const anio = String(row[1] ?? "").trim();
    const cliente = String(row[SECCION_IDX_CLIENTE_PENDIENTES] ?? "").trim();
    const semana = String(row[SECCION_IDX_CLIENTE_PENDIENTES + 1] ?? "").trim();
    const valor = String(row[SECCION_IDX_CLIENTE_PENDIENTES + 2] ?? "").trim();

    if (!cliente) continue;

    const tituloCategoria = TITULOS_SECCION_PENDIENTES[cliente.toUpperCase()];
    if (tituloCategoria) {
      categoriaActual = tituloCategoria;
      continue;
    }

    if (cliente.toUpperCase() === "CLIENTE") continue; // fila de encabezado de columna
    if (!categoriaActual || !valor) continue;

    registros.push({
      categoria: categoriaActual,
      cliente,
      semana,
      valor,
      anio: anio || undefined,
      empresa: empresaRaw === "WOBA" || empresaRaw === "EWORKS" ? (empresaRaw as EmpresaTag) : undefined,
    });
  }

  return registros;
}

// Bug real encontrado en vivo (2026-09-01, corregido en la MISMA sesión que
// el de la columna N de abajo — se me había pasado esta la primera vez):
// columna I:L de DATOS NO es solo GASTOS_FIJOS de punta a punta. Carlos
// agregó, apiladas debajo del bloque normal (que termina fila ~38, con
// subtítulos informales "Impuestos"/"Créditos"/"Servicios" que NO son
// secciones propias, solo texto en la columna concepto sin semana/valor —
// se filtran solos por eso, no necesitan entrada en el mapa de títulos),
// DOS tablas nuevas con su propio recuadro, título fusionado y fila de
// encabezado ("CONSULTOR/SEMANA/VALOR", solo 3 columnas I:K — SIN columna
// de banco): "GASTOS CONSULTORES MES ACTUAL" (título fusionado I40:K41,
// datos desde fila 43) y "GASTOS CONSULTORES PROXIMO MES" (título fusionado
// I60:K61, datos desde fila 63) — verificado en vivo contra el Sheet real,
// incluyendo los merges reales de esas celdas. Antes se leían igual como
// GASTOS_FIJOS genérico (los valores no se perdían, pero no se podían
// distinguir ni comparar como su propia categoría — exactamente lo que
// Carlos pidió reconocer desde el principio).
const SECCION_COLUMNA_I_RANGE = "DATOS!I1:L500";
const TITULOS_SECCION_COLUMNA_I: Record<string, DetalleCategoria> = {
  "GASTOS FIJOS": "GASTOS_FIJOS",
  "GASTOS CONSULTORES MES ACTUAL": "GASTOS_CONSULTORES_MES_ACTUAL",
  "GASTOS CONSULTORES PROXIMO MES": "GASTOS_CONSULTORES_PROXIMO_MES",
};
const ENCABEZADOS_FILA_COLUMNA_I = new Set(["GASTO", "CONSULTOR"]);

function parsearSeccionesColumnaI(rows: string[][]): DetalleRegistro[] {
  const registros: DetalleRegistro[] = [];
  let categoriaActual: DetalleCategoria | null = null;

  for (const row of rows) {
    const concepto = String(row[0] ?? "").trim();
    if (!concepto) continue;

    const tituloCategoria = TITULOS_SECCION_COLUMNA_I[concepto.toUpperCase().trim()];
    if (tituloCategoria) {
      categoriaActual = tituloCategoria;
      continue;
    }

    if (ENCABEZADOS_FILA_COLUMNA_I.has(concepto.toUpperCase())) continue; // fila de encabezado de columna
    if (!categoriaActual) continue;

    const semana = String(row[1] ?? "").trim();
    const valor = String(row[2] ?? "").trim();
    if (!semana && !valor) continue; // subtítulo informal (Impuestos/Créditos/Servicios) u otra fila sin datos

    registros.push({
      categoria: categoriaActual,
      concepto,
      semana,
      valor,
      banco: String(row[3] ?? "").trim() || undefined,
    });
  }

  return registros;
}

// Bug real encontrado en vivo (2026-09-01): la columna N de DATOS NO es solo
// PAGOS_PROYECTOS — Carlos agregó ahí mismo, apiladas debajo, dos secciones
// nuevas ("IMPUESTOS POR PAGAR" en fila 24, "APLAZAMIENTO IMPUESTOS POR
// PAGAR" en fila 39, verificado en vivo contra el Sheet real). El código
// anterior leía TODO N6:R500 como si fuera PAGOS_PROYECTOS de punta a punta
// — las filas de impuestos (ej. "MOD 115 WOBA Q2" | "S43" | "€1,867.22" |
// "2026") se parseaban como si "MOD 115 WOBA Q2" fuera un CLIENTE real de un
// proyecto, con "2026" tratado como el campo EMPRESA — datos corrompidos en
// silencio, y las dos secciones de impuestos nunca se leían como su propia
// categoría (por eso Wobi "no las reconocía" al comparar contra Holded).
// Además, la vieja ubicación fija de APLAZAMIENTO_IMPUESTOS (columnas
// AC:AE) está VACÍA en el Sheet real — esa sección se movió aquí. Mismo
// patrón de detección de título que parsearSeccionesPendientes, pero cada
// sección tiene un esquema de columnas DISTINTO (Pagos Proyectos: cliente/
// proyecto/semana/valor/empresa, 5 columnas; los dos bloques de impuestos:
// impuesto/semana/valor/año, 4 columnas, sin columna de empresa).
const SECCION_COLUMNA_N_RANGE = "DATOS!N1:R500";
const TITULOS_SECCION_COLUMNA_N: Record<string, DetalleCategoria> = {
  "PAGOS PROYECTOS": "PAGOS_PROYECTOS",
  "IMPUESTOS POR PAGAR": "IMPUESTOS_POR_PAGAR",
  "APLAZAMIENTO IMPUESTOS POR PAGAR": "APLAZAMIENTO_IMPUESTOS",
};
const ENCABEZADOS_FILA_COLUMNA_N = new Set(["CLIENTE", "IMPUESTO"]);

function parsearSeccionesColumnaN(rows: string[][]): DetalleRegistro[] {
  const registros: DetalleRegistro[] = [];
  let categoriaActual: DetalleCategoria | null = null;

  for (const row of rows) {
    const primeraCol = String(row[0] ?? "").trim();
    if (!primeraCol) continue;

    const tituloCategoria = TITULOS_SECCION_COLUMNA_N[primeraCol.toUpperCase()];
    if (tituloCategoria) {
      categoriaActual = tituloCategoria;
      continue;
    }

    if (ENCABEZADOS_FILA_COLUMNA_N.has(primeraCol.toUpperCase())) continue; // fila de encabezado de columna
    if (!categoriaActual) continue;

    if (categoriaActual === "PAGOS_PROYECTOS") {
      const [cliente, proyecto, semana, valor, empresaRaw] = row;
      if (!String(semana ?? "").trim() && !String(valor ?? "").trim()) continue;
      const empresaNormalizada = String(empresaRaw ?? "").trim().toUpperCase();
      registros.push({
        categoria: categoriaActual,
        cliente: String(cliente ?? "").trim(),
        proyecto: String(proyecto ?? "").trim(),
        semana: String(semana ?? "").trim(),
        valor: String(valor ?? "").trim(),
        empresa: empresaNormalizada === "WOBA" || empresaNormalizada === "EWORKS" ? (empresaNormalizada as EmpresaTag) : undefined,
      });
    } else {
      // IMPUESTOS_POR_PAGAR / APLAZAMIENTO_IMPUESTOS: impuesto/semana/valor/año.
      const [concepto, semana, valor, anio] = row;
      if (!String(semana ?? "").trim() && !String(valor ?? "").trim()) continue;
      registros.push({
        categoria: categoriaActual,
        concepto: String(concepto ?? "").trim(),
        semana: String(semana ?? "").trim(),
        valor: String(valor ?? "").trim(),
        anio: String(anio ?? "").trim() || undefined,
      });
    }
  }

  return registros;
}

// Cache muy corta (unos segundos) en memoria — pensada para colapsar las
// MUCHAS llamadas repetidas que ocurren dentro de una sola pregunta del
// usuario (ej. "qué está por vencer y cuánto suma" puede disparar 8-10
// búsquedas distintas — una por palabra clave de cada vencimiento — cada
// una releyendo la hoja completa desde cero). No es una cache de larga
// duración: el cashflow puede cambiar por una aprobación real en cualquier
// momento, así que se vence rápido a propósito, solo para el "ráfaga" de
// llamadas de un mismo turno de conversación.
const CACHE_DETALLE_TTL_MS = enteroAcotado(process.env.WOBI_CASHFLOW_CACHE_TTL_MS, 10_000, 0, 60_000);
const cacheDetalle = new CacheLectura<DetalleRegistro[]>("cashflow_detalle", CACHE_DETALLE_TTL_MS);

// Encabezados esperados fila 5 (verificado en vivo) para los 2 bloques de columnas fijas.
const HEADERS_ESPERADOS_INGRESOS = ["CLIENTE", "PROYECTO", "SEMANA", "VALOR", "EMPRESA"];
const HEADERS_ESPERADOS_PAGOS_EXTRAS = ["CLIENTE", "SEMANA", "VALOR"];

/**
 * Pedido explícito de Carlos (2026-09-09): "algunas veces incluimos o
 * quitamos filas o columnas y esto mueve las áreas de acción y lectura de
 * los datos" — que el sistema releea y confirme que las áreas siguen en su
 * lugar antes de confiar en una búsqueda, no solo una vez al programarlo.
 *
 * Nace de un caso real encontrado en la MISMA sesión en que Carlos pidió
 * esto: la sección de Pendientes (X:Z) llevaba un tiempo indeterminado con
 * su columna de título desplazada (Carlos agregó EMPRESA y AÑO delante, ver
 * hallazgo en parsearSeccionesPendientes) — cada fila real (Alberto,
 * Carrefour, Susana Iso...) se descartaba en silencio, sin ningún error, en
 * NINGUNA lectura del cashflow, hasta que se investigó a mano. Este chequeo
 * existe para que la PRÓXIMA vez que Carlos mueva algo así, quede detectado
 * solo — no otra vez a mano.
 *
 * No lanza excepción (un falso positivo acá no debe tumbar la lectura real
 * del cashflow) — solo junta problemas encontrados; fetchDetalleRegistros
 * los registra en consola en cada lectura fresca, y revisarEstructuraCashflow.ts
 * (job diario) avisa a Carlos por Telegram si encuentra alguno.
 */
export interface ProblemaEstructuraDatos {
  bloque: string;
  detalle: string;
}

function verificarHeaders(headers: string[] | undefined, esperados: string[], bloque: string, problemas: ProblemaEstructuraDatos[]): void {
  const reales = (headers ?? []).map((h) => String(h ?? "").trim().toUpperCase());
  esperados.forEach((esperado, i) => {
    if (reales[i] !== esperado) {
      problemas.push({
        bloque,
        detalle: `Encabezado esperado "${esperado}" en la posición ${i + 1} no coincide (encontrado: "${reales[i] ?? "(vacío)"}") — la fila de encabezados pudo moverse o cambiar.`,
      });
    }
  });
}

function verificarTitulosEncontrados(
  rows: string[][],
  idxTitulo: number,
  titulos: Record<string, unknown>,
  bloque: string,
  problemas: ProblemaEstructuraDatos[]
): void {
  const encontrados = new Set(rows.map((r) => String(r[idxTitulo] ?? "").trim().toUpperCase()));
  for (const titulo of Object.keys(titulos)) {
    if (!encontrados.has(titulo)) {
      problemas.push({
        bloque,
        detalle: `No se encontró la sección "${titulo}" donde se esperaba (columna de título habitual) — pudo moverse de columna, renombrarse, o borrarse.`,
      });
    }
  }
}

/**
 * Hallazgo real de auditoría xhigh (2ª ronda): verificarTitulosEncontrados solo confirma que el
 * TÍTULO de cada sección siga en la columna esperada — pero si Carlos inserta una columna nueva a la
 * DERECHA de un título (dentro del mismo bloque, sin mover el título en sí), el título se sigue
 * encontrando bien mientras que las columnas de datos que le siguen (semana/valor) quedan corridas —
 * exactamente la misma clase de corrupción silenciosa que motivó este fix completo, un paso más allá
 * de lo que el chequeo por título puede ver. Esta verificación es independiente de cualquier columna
 * fija: sobre los registros YA parseados, confirma que `valor` de verdad tenga forma de un importe real
 * (dígitos, separadores de miles/decimales, símbolo de moneda opcional) — si algo como "S40" (un código
 * de semana corrido a la columna de valor) aparece ahí, se detecta sin necesitar saber DÓNDE se movió.
 */
const FORMA_VALOR_VALIDO = /^[\s€$]*[\d.,]+[\s€$]*$/;

function verificarFormaValores(registros: DetalleRegistro[], problemas: ProblemaEstructuraDatos[]): void {
  for (const r of registros) {
    if (r.valor && !FORMA_VALOR_VALIDO.test(r.valor)) {
      problemas.push({
        bloque: r.categoria,
        detalle: `El valor "${r.valor}" (cliente/concepto: "${r.cliente ?? r.concepto ?? "?"}") no tiene forma de importe real — puede que una columna se haya corrido y esto sea en realidad otro dato (semana, texto, etc.).`,
      });
    }
  }
}

let ultimaVerificacionEstructura: ProblemaEstructuraDatos[] = [];

/** Problemas de estructura detectados en la última lectura FRESCA (no cacheada) de fetchDetalleRegistros. */
export function obtenerUltimaVerificacionEstructura(): ProblemaEstructuraDatos[] {
  return ultimaVerificacionEstructura;
}

/**
 * Lee TODOS los movimientos de detalle de la hoja DATOS: ingresos, pagos a
 * proyectos, pagos extras, impuestos por pagar, aplazamientos de impuestos,
 * gastos fijos (nóminas, créditos, servicios), gastos consultores (mes
 * actual y próximo mes, categorías propias) y pendientes (Alberto / deudas
 * con otros), sin filtrar.
 */
async function cargarDetalleRegistros(): Promise<DetalleRegistro[]> {
  const sheetId = assertSheetId();
  const sheets = getSheetsClient();

  // Rangos de encabezado (fila 5) agregados AL FINAL para el chequeo de estructura de abajo — no
  // participan en el parseo de datos en sí, solo en verificarHeaders.
  const IDX_HEADER_INGRESOS = DETALLE_BLOCKS.length + 3;
  const IDX_HEADER_PAGOS_EXTRAS = DETALLE_BLOCKS.length + 4;
  const resp = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: sheetId,
    ranges: [
      ...DETALLE_BLOCKS.map((b) => b.range),
      SECCION_PENDIENTES_RANGE,
      SECCION_COLUMNA_N_RANGE,
      SECCION_COLUMNA_I_RANGE,
      "DATOS!B5:F5",
      "DATOS!T5:V5",
    ],
    valueRenderOption: "FORMATTED_VALUE",
  });

  const valueRanges = resp.data.valueRanges ?? [];
  const registros: DetalleRegistro[] = [];

  DETALLE_BLOCKS.forEach((block, blockIdx) => {
    const rows = valueRanges[blockIdx]?.values ?? [];

    rows.forEach((row) => {
      const record: Partial<DetalleRegistro> = { categoria: block.categoria };
      block.fields.forEach((field, colIdx) => {
        const raw = row[colIdx] ?? "";
        if (field === "empresa") {
          const normalizado = String(raw).trim().toUpperCase();
          record.empresa = normalizado === "WOBA" || normalizado === "EWORKS" ? (normalizado as EmpresaTag) : undefined;
        } else {
          record[field] = raw;
        }
      });

      if (!record.semana && !record.valor) return;

      registros.push(record as DetalleRegistro);
    });
  });

  const filasPendientes = valueRanges[DETALLE_BLOCKS.length]?.values ?? [];
  registros.push(...parsearSeccionesPendientes(filasPendientes as string[][]));

  const filasColumnaN = valueRanges[DETALLE_BLOCKS.length + 1]?.values ?? [];
  registros.push(...parsearSeccionesColumnaN(filasColumnaN as string[][]));

  const filasColumnaI = valueRanges[DETALLE_BLOCKS.length + 2]?.values ?? [];
  registros.push(...parsearSeccionesColumnaI(filasColumnaI as string[][]));

  // Verificación de estructura — ver comentario junto a ProblemaEstructuraDatos arriba. Se corre en
  // CADA lectura fresca (no cacheada), sobre los mismos datos que ya se acaban de leer, sin ningún
  // round-trip extra a Sheets.
  const problemas: ProblemaEstructuraDatos[] = [];
  verificarHeaders(valueRanges[IDX_HEADER_INGRESOS]?.values?.[0], HEADERS_ESPERADOS_INGRESOS, "INGRESOS", problemas);
  verificarHeaders(valueRanges[IDX_HEADER_PAGOS_EXTRAS]?.values?.[0], HEADERS_ESPERADOS_PAGOS_EXTRAS, "PAGOS_EXTRAS", problemas);
  verificarTitulosEncontrados(filasPendientes as string[][], SECCION_IDX_CLIENTE_PENDIENTES, TITULOS_SECCION_PENDIENTES, "PENDIENTES (W:AB)", problemas);
  verificarTitulosEncontrados(filasColumnaN as string[][], 0, TITULOS_SECCION_COLUMNA_N, "COLUMNA N (PAGOS_PROYECTOS)", problemas);
  verificarTitulosEncontrados(filasColumnaI as string[][], 0, TITULOS_SECCION_COLUMNA_I, "COLUMNA I (GASTOS_FIJOS)", problemas);
  verificarFormaValores(registros, problemas);

  if (problemas.length > 0) {
    console.error(
      `[cashflowSheet] Posible cambio de estructura en la hoja DATOS — ${problemas.length} problema(s) detectado(s):\n` +
        problemas.map((p) => `  • [${p.bloque}] ${p.detalle}`).join("\n")
    );
  }
  ultimaVerificacionEstructura = problemas;

  return registros;
}

export function fetchDetalleRegistrosConMeta(): Promise<LecturaConMeta<DetalleRegistro[]>> {
  return cacheDetalle.obtener(cargarDetalleRegistros);
}

export async function fetchDetalleRegistros(): Promise<DetalleRegistro[]> {
  return (await fetchDetalleRegistrosConMeta()).datos;
}

/** Invalida la cache de arriba — llamar justo después de escribir en DATOS para que la próxima lectura sea fresca. */
export function invalidarCacheDetalleRegistros(): void {
  cacheDetalle.invalidar();
}

export function invalidarCachesCashflow(): void {
  cacheResumen.invalidar();
  cacheDetalle.invalidar();
}

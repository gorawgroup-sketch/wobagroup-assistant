import type {
  DetalleCategoria,
  DetalleRegistro,
  EmpresaTag,
} from "./cashflowSheet";

type CampoDetalle =
  | "cliente"
  | "proyecto"
  | "concepto"
  | "semana"
  | "valor"
  | "empresa"
  | "banco"
  | "anio";

interface CampoSeccion {
  campo: CampoDetalle;
  encabezados: string[];
  requerido?: boolean;
  /** Algunos metadatos de Pendientes están a la izquierda de CLIENTE. */
  lado?: "izquierda" | "derecha";
}

interface EspecificacionSeccion {
  categoria: DetalleCategoria;
  titulos: string[];
  principal: CampoDetalle;
  campos: CampoSeccion[];
  heredaOpcionalesDe?: DetalleCategoria;
}

interface Posicion {
  fila: number;
  columna: number;
}

interface DisposicionSeccion {
  especificacion: EspecificacionSeccion;
  titulo: Posicion;
  filaEncabezado: number;
  columnas: Partial<Record<CampoDetalle, number>>;
}

export interface ProblemaEstructuraDatos {
  bloque: string;
  detalle: string;
}

export interface ResultadoMatrizCashflow {
  registros: DetalleRegistro[];
  problemas: ProblemaEstructuraDatos[];
}

const MAX_DESPLAZAMIENTO_ENCABEZADO = 6;
const RADIO_COLUMNAS_ENCABEZADO = 8;
const RADIO_COLUMNA_PRINCIPAL = 3;
const RADIO_COLUMNAS_IZQUIERDA = 4;
const FILAS_VACIAS_PARA_FIN = 3;

const SECCIONES: EspecificacionSeccion[] = [
  {
    categoria: "INGRESOS",
    titulos: ["INGRESOS WOBA GROUP", "INGRESOS"],
    principal: "cliente",
    campos: [
      { campo: "cliente", encabezados: ["CLIENTE"], requerido: true },
      { campo: "proyecto", encabezados: ["PROYECTO"], requerido: true },
      { campo: "semana", encabezados: ["SEMANA"], requerido: true },
      { campo: "valor", encabezados: ["VALOR"], requerido: true },
      { campo: "empresa", encabezados: ["EMPRESA"], requerido: true },
    ],
  },
  {
    categoria: "GASTOS_FIJOS",
    titulos: ["GASTOS FIJOS"],
    principal: "concepto",
    campos: [
      { campo: "concepto", encabezados: ["GASTO"], requerido: true },
      { campo: "semana", encabezados: ["SEMANA"], requerido: true },
      { campo: "valor", encabezados: ["VALOR"], requerido: true },
      { campo: "banco", encabezados: ["BANCO"] },
      { campo: "empresa", encabezados: ["EMPRESA"] },
    ],
  },
  {
    categoria: "PAGOS_PROYECTOS",
    titulos: ["PAGOS PROYECTOS"],
    principal: "cliente",
    campos: [
      { campo: "cliente", encabezados: ["CLIENTE"], requerido: true },
      { campo: "proyecto", encabezados: ["PROYECTO"], requerido: true },
      { campo: "semana", encabezados: ["SEMANA"], requerido: true },
      { campo: "valor", encabezados: ["VALOR"], requerido: true },
      { campo: "empresa", encabezados: ["EMPRESA"], requerido: true },
    ],
  },
  {
    categoria: "PAGOS_EXTRAS",
    titulos: ["PAGOS EXTRAS"],
    principal: "cliente",
    campos: [
      { campo: "cliente", encabezados: ["CLIENTE"], requerido: true },
      { campo: "semana", encabezados: ["SEMANA"], requerido: true },
      { campo: "valor", encabezados: ["VALOR"], requerido: true },
      { campo: "empresa", encabezados: ["EMPRESA"], requerido: true },
    ],
  },
  {
    categoria: "PAGOS_PENDIENTES_ALBERTO",
    titulos: ["PAGOS PENDIENTES ALBERTO"],
    principal: "cliente",
    campos: [
      { campo: "empresa", encabezados: ["EMPRESA"], lado: "izquierda" },
      { campo: "anio", encabezados: ["ANO", "AN0"], lado: "izquierda" },
      { campo: "cliente", encabezados: ["CLIENTE"], requerido: true },
      { campo: "semana", encabezados: ["SEMANA"], requerido: true },
      { campo: "valor", encabezados: ["VALOR"], requerido: true },
    ],
  },
  {
    categoria: "DEUDAS_PENDIENTES",
    titulos: ["DEUDAS PENDIENTES OTROS"],
    principal: "cliente",
    heredaOpcionalesDe: "PAGOS_PENDIENTES_ALBERTO",
    campos: [
      { campo: "empresa", encabezados: ["EMPRESA"], lado: "izquierda" },
      { campo: "anio", encabezados: ["ANO", "AN0"], lado: "izquierda" },
      { campo: "cliente", encabezados: ["CLIENTE"], requerido: true },
      { campo: "semana", encabezados: ["SEMANA"], requerido: true },
      { campo: "valor", encabezados: ["VALOR"], requerido: true },
    ],
  },
  {
    categoria: "IMPUESTOS_POR_PAGAR",
    titulos: ["IMPUESTOS POR PAGAR"],
    principal: "concepto",
    campos: [
      { campo: "concepto", encabezados: ["IMPUESTO"], requerido: true },
      { campo: "semana", encabezados: ["SEMANA"], requerido: true },
      { campo: "valor", encabezados: ["VALOR"], requerido: true },
      { campo: "anio", encabezados: ["ANO", "AN0"] },
      { campo: "empresa", encabezados: ["EMPRESA"] },
    ],
  },
  {
    categoria: "APLAZAMIENTO_IMPUESTOS",
    titulos: ["APLAZAMIENTO IMPUESTOS POR PAGAR"],
    principal: "concepto",
    campos: [
      { campo: "concepto", encabezados: ["IMPUESTO"], requerido: true },
      { campo: "semana", encabezados: ["SEMANA"], requerido: true },
      { campo: "valor", encabezados: ["VALOR"], requerido: true },
      { campo: "anio", encabezados: ["ANO", "AN0"] },
      { campo: "empresa", encabezados: ["EMPRESA"] },
    ],
  },
  {
    categoria: "GASTOS_CONSULTORES_MES_ACTUAL",
    titulos: ["GASTOS CONSULTORES MES ACTUAL"],
    principal: "concepto",
    campos: [
      { campo: "concepto", encabezados: ["CONSULTOR"], requerido: true },
      { campo: "semana", encabezados: ["SEMANA"], requerido: true },
      { campo: "valor", encabezados: ["VALOR"], requerido: true },
      { campo: "empresa", encabezados: ["EMPRESA"] },
    ],
  },
  {
    categoria: "GASTOS_CONSULTORES_PROXIMO_MES",
    titulos: ["GASTOS CONSULTORES PROXIMO MES"],
    principal: "concepto",
    campos: [
      { campo: "concepto", encabezados: ["CONSULTOR"], requerido: true },
      { campo: "semana", encabezados: ["SEMANA"], requerido: true },
      { campo: "valor", encabezados: ["VALOR"], requerido: true },
      { campo: "empresa", encabezados: ["EMPRESA"] },
    ],
  },
];

function normalizarEtiqueta(valor: unknown): string {
  return String(valor ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function textoCelda(filas: unknown[][], fila: number, columna: number): string {
  return String(filas[fila]?.[columna] ?? "").trim();
}

function nombreColumna(indice: number): string {
  let resultado = "";
  for (let valor = indice + 1; valor > 0; valor = Math.floor((valor - 1) / 26)) {
    resultado = String.fromCharCode(65 + ((valor - 1) % 26)) + resultado;
  }
  return resultado;
}

function referenciaCelda(fila: number, columna: number): string {
  return `${nombreColumna(columna)}${fila + 1}`;
}

function buscarTitulos(filas: unknown[][], especificacion: EspecificacionSeccion): Posicion[] {
  const titulos = new Set(especificacion.titulos.map(normalizarEtiqueta));
  const encontrados: Posicion[] = [];
  filas.forEach((fila, filaIdx) => {
    fila.forEach((valor, columnaIdx) => {
      if (titulos.has(normalizarEtiqueta(valor))) {
        encontrados.push({ fila: filaIdx, columna: columnaIdx });
      }
    });
  });
  return encontrados;
}

function buscarColumna(
  fila: unknown[],
  encabezados: string[],
  desde: number,
  hasta: number,
  preferida: number
): number | undefined {
  const permitidos = new Set(encabezados.map(normalizarEtiqueta));
  const candidatas: number[] = [];
  for (let columna = Math.max(0, desde); columna <= Math.min(fila.length - 1, hasta); columna += 1) {
    if (permitidos.has(normalizarEtiqueta(fila[columna]))) candidatas.push(columna);
  }
  return candidatas.sort((a, b) => Math.abs(a - preferida) - Math.abs(b - preferida))[0];
}

function descubrirEncabezado(
  filas: unknown[][],
  especificacion: EspecificacionSeccion,
  titulo: Posicion
): DisposicionSeccion | null {
  const campoPrincipal = especificacion.campos.find((campo) => campo.campo === especificacion.principal);
  if (!campoPrincipal) return null;

  for (
    let filaIdx = titulo.fila;
    filaIdx <= Math.min(filas.length - 1, titulo.fila + MAX_DESPLAZAMIENTO_ENCABEZADO);
    filaIdx += 1
  ) {
    const fila = filas[filaIdx] ?? [];
    const columnaPrincipal = buscarColumna(
      fila,
      campoPrincipal.encabezados,
      titulo.columna - RADIO_COLUMNA_PRINCIPAL,
      titulo.columna + RADIO_COLUMNA_PRINCIPAL,
      titulo.columna
    );
    if (columnaPrincipal === undefined) continue;

    const columnas: Partial<Record<CampoDetalle, number>> = {
      [especificacion.principal]: columnaPrincipal,
    };
    let columnaDerecha = columnaPrincipal;
    let valida = true;
    const camposDerecha = especificacion.campos.filter((campo) => campo.lado !== "izquierda").length;
    const limiteDerecha = columnaPrincipal + Math.max(2, camposDerecha + 1);

    for (const campo of especificacion.campos) {
      if (campo.campo === especificacion.principal || campo.lado === "izquierda") continue;
      const columna = buscarColumna(
        fila,
        campo.encabezados,
        columnaDerecha + 1,
        Math.min(columnaPrincipal + RADIO_COLUMNAS_ENCABEZADO, limiteDerecha),
        columnaDerecha + 1
      );
      if (columna === undefined) {
        if (campo.requerido) valida = false;
        continue;
      }
      columnas[campo.campo] = columna;
      columnaDerecha = columna;
    }

    for (const campo of especificacion.campos.filter((item) => item.lado === "izquierda")) {
      const columna = buscarColumna(
        fila,
        campo.encabezados,
        columnaPrincipal - RADIO_COLUMNAS_IZQUIERDA,
        columnaPrincipal - 1,
        columnaPrincipal - 1
      );
      if (columna === undefined) {
        if (campo.requerido) valida = false;
        continue;
      }
      columnas[campo.campo] = columna;
    }

    if (valida) {
      return { especificacion, titulo, filaEncabezado: filaIdx, columnas };
    }
  }

  return null;
}

function obtenerDisposiciones(
  filas: unknown[][],
  problemas: ProblemaEstructuraDatos[]
): DisposicionSeccion[] {
  const disposiciones: DisposicionSeccion[] = [];

  for (const especificacion of SECCIONES) {
    const titulos = buscarTitulos(filas, especificacion);
    const candidatas = titulos
      .map((titulo) => descubrirEncabezado(filas, especificacion, titulo))
      .filter((valor): valor is DisposicionSeccion => valor !== null);

    if (candidatas.length === 1) {
      disposiciones.push(candidatas[0]);
      continue;
    }

    problemas.push({
      bloque: especificacion.categoria,
      detalle:
        candidatas.length === 0
          ? `WOBI releyó toda la hoja pero no pudo localizar de forma inequívoca el título y los encabezados de ${especificacion.categoria}.`
          : `WOBI encontró más de una tabla válida para ${especificacion.categoria}; no combinará datos ambiguos.`,
    });
  }

  const porCategoria = new Map(disposiciones.map((disposicion) => [disposicion.especificacion.categoria, disposicion]));
  for (const disposicion of disposiciones) {
    const heredada = disposicion.especificacion.heredaOpcionalesDe
      ? porCategoria.get(disposicion.especificacion.heredaOpcionalesDe)
      : undefined;
    if (!heredada) continue;
    for (const campo of disposicion.especificacion.campos.filter((item) => !item.requerido)) {
      if (disposicion.columnas[campo.campo] === undefined && heredada.columnas[campo.campo] !== undefined) {
        disposicion.columnas[campo.campo] = heredada.columnas[campo.campo];
      }
    }
  }

  return disposiciones;
}

const FORMA_VALOR_VALIDO = /^\s*(?:[-+]?[\s€$£]*[\d.,]+[\s€$£]*|\([\s€$£]*[\d.,]+[\s€$£]*\))\s*$/;

function convertirEmpresa(valor: string): EmpresaTag | undefined {
  const normalizada = normalizarEtiqueta(valor);
  return normalizada === "WOBA" || normalizada === "EWORKS" ? (normalizada as EmpresaTag) : undefined;
}

function siguienteTituloMismaZona(
  actual: DisposicionSeccion,
  disposiciones: DisposicionSeccion[]
): number | undefined {
  const principal = actual.columnas[actual.especificacion.principal];
  if (principal === undefined) return undefined;
  return disposiciones
    .filter((otra) => {
      if (otra.titulo.fila <= actual.filaEncabezado) return false;
      const principalOtra = otra.columnas[otra.especificacion.principal];
      return principalOtra !== undefined && Math.abs(principalOtra - principal) <= 1;
    })
    .map((otra) => otra.titulo.fila)
    .sort((a, b) => a - b)[0];
}

function parsearSeccion(
  filas: unknown[][],
  disposicion: DisposicionSeccion,
  todas: DisposicionSeccion[],
  problemas: ProblemaEstructuraDatos[]
): DetalleRegistro[] {
  const registros: DetalleRegistro[] = [];
  const { especificacion, columnas } = disposicion;
  const columnaPrincipal = columnas[especificacion.principal];
  const columnaValor = columnas.valor;
  if (columnaPrincipal === undefined || columnaValor === undefined) return registros;

  const limitePorTitulo = siguienteTituloMismaZona(disposicion, todas) ?? filas.length;
  let vaciasConsecutivas = 0;
  let encontroContenido = false;
  let avisoHuecoRegistrado = false;

  for (let filaIdx = disposicion.filaEncabezado + 1; filaIdx < limitePorTitulo; filaIdx += 1) {
    // El campo principal obligatorio define si esta fila pertenece a la tabla. Columnas opcionales
    // pueden solaparse verticalmente con tablas vecinas y no deben prolongar esta sección por sí solas.
    const principal = textoCelda(filas, filaIdx, columnaPrincipal);
    const valor = textoCelda(filas, filaIdx, columnaValor);
    const tieneContenido = principal !== "";

    if (!tieneContenido) {
      if (encontroContenido) vaciasConsecutivas += 1;
      continue;
    }
    if (encontroContenido && vaciasConsecutivas >= FILAS_VACIAS_PARA_FIN && !avisoHuecoRegistrado) {
      problemas.push({
        bloque: especificacion.categoria,
        detalle:
          `La tabla ${especificacion.categoria} continúa en la fila ${filaIdx + 1} después de ` +
          `${vaciasConsecutivas} filas vacías. WOBI leyó las filas posteriores, pero marca la cobertura para revisión.`,
      });
      avisoHuecoRegistrado = true;
    }
    encontroContenido = true;
    vaciasConsecutivas = 0;

    if (!valor) {
      problemas.push({
        bloque: especificacion.categoria,
        detalle: `La fila ${filaIdx + 1} de ${especificacion.categoria} tiene concepto pero no importe; WOBI la excluyó.`,
      });
      continue;
    }

    if (!FORMA_VALOR_VALIDO.test(valor)) {
      problemas.push({
        bloque: especificacion.categoria,
        detalle: `La celda ${referenciaCelda(filaIdx, columnaValor)} contiene "${valor}" en lugar de un importe; WOBI excluyó solo esa fila y mantuvo el resto de la tabla.`,
      });
      continue;
    }

    const registro: DetalleRegistro = {
      categoria: especificacion.categoria,
      fila: filaIdx + 1,
      semana: columnas.semana === undefined ? "" : textoCelda(filas, filaIdx, columnas.semana),
      valor,
    };
    if (columnas.cliente !== undefined) registro.cliente = textoCelda(filas, filaIdx, columnas.cliente);
    if (columnas.proyecto !== undefined) registro.proyecto = textoCelda(filas, filaIdx, columnas.proyecto);
    if (columnas.concepto !== undefined) registro.concepto = textoCelda(filas, filaIdx, columnas.concepto);
    if (columnas.banco !== undefined) registro.banco = textoCelda(filas, filaIdx, columnas.banco) || undefined;
    if (columnas.anio !== undefined) registro.anio = textoCelda(filas, filaIdx, columnas.anio) || undefined;
    if (columnas.empresa !== undefined) registro.empresa = convertirEmpresa(textoCelda(filas, filaIdx, columnas.empresa));
    registros.push(registro);
  }

  return registros;
}

/**
 * Descubre títulos y encabezados en cada lectura; las posiciones históricas no participan en el parseo.
 * Un movimiento de filas o columnas se absorbe automáticamente. Solo se reporta lo que no puede
 * resolverse sin inventar datos (tabla ausente/duplicada o un importe inválido dentro de una tabla real).
 */
export function analizarMatrizCashflow(filas: unknown[][]): ResultadoMatrizCashflow {
  const problemas: ProblemaEstructuraDatos[] = [];
  const disposiciones = obtenerDisposiciones(filas, problemas);
  const registros = disposiciones.flatMap((disposicion) =>
    parsearSeccion(filas, disposicion, disposiciones, problemas)
  );
  return { registros, problemas };
}

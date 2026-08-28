import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "./serviceAccount";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;

let writeClient: sheets_v4.Sheets | null = null;

/**
 * Cliente de Sheets con permiso de escritura (scope completo, distinto al
 * cliente de solo lectura usado por los tools de consulta). Se usa
 * exclusivamente desde el flujo de escritura aprobado por Telegram.
 */
function getSheetsWriteClient(): sheets_v4.Sheets {
  if (writeClient) return writeClient;

  const credentials = loadServiceAccountCredentials();

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  writeClient = google.sheets({ version: "v4", auth });
  return writeClient;
}

function assertSheetId(): string {
  if (!CASHFLOW_SHEET_ID) {
    throw new Error("Falta la variable de entorno CASHFLOW_SHEET_ID.");
  }
  return CASHFLOW_SHEET_ID;
}

export type BloqueEscritura =
  | "ingresos"
  | "pagos_proyectos"
  | "pagos_extras"
  | "gastos_fijos"
  | "aplazamiento_impuestos"
  | "pagos_pendientes_alberto"
  | "deudas_pendientes";

/** Los últimos dos (columnas X:Z compartidas por título de sección) usan un escritor aparte, ver más abajo. */
export const BLOQUES_SECCION_COMPARTIDA: BloqueEscritura[] = ["pagos_pendientes_alberto", "deudas_pendientes"];

interface BloqueColumnas {
  /** Columna a usar para detectar la primera fila vacía (siempre VALOR). */
  columnaChequeo: string;
  /** Rango inicial (letra) del bloque, para construir el rango de escritura. */
  columnaInicio: string;
  /** Rango final (letra) del bloque. */
  columnaFin: string;
  /** Orden de campos tal como se escriben en las columnas del bloque. */
  campos: Array<"cliente" | "concepto" | "proyecto" | "semana" | "valor" | "empresa" | "banco">;
  tieneEmpresa: boolean;
}

// Solo los bloques de columnas FIJAS y contiguas — pagos_pendientes_alberto
// y deudas_pendientes comparten columnas (X:Z) separadas por título de
// sección, no encajan en este modelo, y usan un escritor aparte más abajo
// (registrarPendienteEnSheet).
const BLOQUE_CONFIG: Partial<Record<BloqueEscritura, BloqueColumnas>> = {
  ingresos: {
    columnaChequeo: "E",
    columnaInicio: "B",
    columnaFin: "F",
    campos: ["cliente", "proyecto", "semana", "valor", "empresa"],
    tieneEmpresa: true,
  },
  pagos_proyectos: {
    columnaChequeo: "Q",
    columnaInicio: "N",
    columnaFin: "R",
    campos: ["cliente", "proyecto", "semana", "valor", "empresa"],
    tieneEmpresa: true,
  },
  pagos_extras: {
    columnaChequeo: "V",
    columnaInicio: "T",
    columnaFin: "V",
    campos: ["cliente", "semana", "valor"],
    tieneEmpresa: false,
  },
  // Columnas I:L de DATOS (GASTO/SEMANA/VALOR/BANCO) — mismo bloque que ya
  // se lee para consultar_cashflow_detalle y para el comparativo contra
  // Holded, ahora también escribible.
  gastos_fijos: {
    columnaChequeo: "K",
    columnaInicio: "I",
    columnaFin: "L",
    campos: ["concepto", "semana", "valor", "banco"],
    tieneEmpresa: false,
  },
  // Columnas AC:AE de DATOS (CONCEPTO/SEMANA/VALOR) — mismo bloque simple
  // que gastos_fijos, sin columna de banco.
  aplazamiento_impuestos: {
    columnaChequeo: "AE",
    columnaInicio: "AC",
    columnaFin: "AE",
    campos: ["concepto", "semana", "valor"],
    tieneEmpresa: false,
  },
};

const PRIMERA_FILA_DATOS = 6;
const ULTIMA_FILA_BUSQUEDA = 500;

/**
 * Busca la primera fila REALMENTE vacía dentro del bloque, a partir de la
 * fila 6, para escribir ahí una fila NUEVA sin pisar datos existentes.
 *
 * Chequea TODAS las columnas del bloque, no solo VALOR — bug real encontrado
 * y corregido en auditoría: gastos_fijos tiene sub-encabezados de categoría
 * ("Impuestos", "Créditos", "Servicios"...) que ocupan la columna de
 * CONCEPTO pero dejan VALOR vacío; chequear solo VALOR marcaba esa fila
 * como "disponible" y sobrescribía el sub-encabezado. Verificado en vivo
 * contra la fila real, restaurada tras el hallazgo.
 */
async function findNextEmptyRow(bloque: BloqueEscritura): Promise<number> {
  const sheetId = assertSheetId();
  const sheets = getSheetsWriteClient();
  const config = BLOQUE_CONFIG[bloque];
  if (!config) {
    throw new Error(`El bloque "${bloque}" no usa findNextEmptyRow — usa registrarPendienteEnSheet.`);
  }
  const { columnaInicio, columnaFin } = config;

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `DATOS!${columnaInicio}${PRIMERA_FILA_DATOS}:${columnaFin}${ULTIMA_FILA_BUSQUEDA}`,
    valueRenderOption: "FORMATTED_VALUE",
  });

  // La API de Sheets no devuelve filas vacías al final del rango (las trunca),
  // así que `values` solo cubre hasta la última fila con contenido. Un hueco
  // vacío ENTRE filas con datos sí se devuelve como fila []. Por eso:
  // - si hay un hueco real (TODAS las columnas del bloque vacías) dentro de
  //   los datos devueltos, se usa ese;
  // - si no hay hueco, la siguiente fila vacía es la que sigue al final de
  //   lo devuelto (values.length), no un error.
  const values = resp.data.values ?? [];
  const filaVacia = (row: unknown[] | undefined): boolean =>
    !row || row.every((celda) => celda === undefined || celda === null || String(celda).trim() === "");
  const offsetConHueco = values.findIndex((row) => filaVacia(row));
  const offset = offsetConHueco !== -1 ? offsetConHueco : values.length;

  const fila = PRIMERA_FILA_DATOS + offset;

  if (fila > ULTIMA_FILA_BUSQUEDA) {
    throw new Error(
      `El bloque "${bloque}" no tiene espacio disponible dentro del rango de búsqueda ` +
        `(filas ${PRIMERA_FILA_DATOS}-${ULTIMA_FILA_BUSQUEDA}). Amplía ULTIMA_FILA_BUSQUEDA.`
    );
  }

  return fila;
}

export interface NuevoMovimiento {
  bloque: BloqueEscritura;
  cliente_o_concepto: string;
  proyecto?: string;
  /** Solo aplica a 'gastos_fijos' (columna banco). Ignorado en el resto de bloques. */
  banco?: string;
  semana: string;
  valor: number;
  empresa: "WOBA" | "EWORKS";
}

export interface ResultadoEscritura {
  ok: boolean;
  mensaje: string;
  fila?: number;
  rango?: string;
}

/**
 * Escribe una fila NUEVA (nunca modifica una existente) en el bloque
 * correspondiente de la hoja DATOS, y lee de vuelta la celda escrita para
 * confirmar que se guardó correctamente.
 */
export async function registrarMovimientoEnSheet(movimiento: NuevoMovimiento): Promise<ResultadoEscritura> {
  const sheetId = assertSheetId();
  const sheets = getSheetsWriteClient();
  const config = BLOQUE_CONFIG[movimiento.bloque];
  if (!config) {
    throw new Error(`El bloque "${movimiento.bloque}" no usa registrarMovimientoEnSheet — usa registrarPendienteEnSheet.`);
  }

  const fila = await findNextEmptyRow(movimiento.bloque);
  const rango = `DATOS!${config.columnaInicio}${fila}:${config.columnaFin}${fila}`;

  const valoresPorCampo: Record<string, string | number> = {
    cliente: movimiento.cliente_o_concepto,
    concepto: movimiento.cliente_o_concepto,
    proyecto: movimiento.proyecto ?? "",
    banco: movimiento.banco ?? "",
    semana: movimiento.semana,
    valor: movimiento.valor,
    empresa: movimiento.empresa,
  };

  const fila_valores = config.campos.map((campo) => valoresPorCampo[campo]);

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: rango,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [fila_valores] },
  });

  const verificacion = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: rango,
    valueRenderOption: "FORMATTED_VALUE",
  });

  const filaEscrita = verificacion.data.values?.[0];
  const valorEscrito = filaEscrita?.[config.campos.indexOf("valor")];

  if (!filaEscrita || valorEscrito === undefined || valorEscrito === "") {
    return {
      ok: false,
      mensaje:
        `Se intentó escribir en ${rango} pero la verificación de lectura no encontró el valor esperado. ` +
        "Revisa manualmente la hoja antes de reintentar.",
      fila,
      rango,
    };
  }

  return {
    ok: true,
    mensaje: `Movimiento registrado y verificado en ${rango}.`,
    fila,
    rango,
  };
}

// Columnas X:Z de DATOS: dos secciones apiladas bajo su propio título
// ("PAGOS PENDIENTES ALBERTO" y "DEUDAS PENDIENTES OTROS"), sin rango de
// filas fijo por sección — mismos títulos que ya usa el lado de LECTURA
// (parsearSeccionesPendientes en cashflowSheet.ts).
const SECCION_COLUMNA_INICIO = "X";
const SECCION_COLUMNA_FIN = "Z";
const SECCION_RANGO_LECTURA = `DATOS!${SECCION_COLUMNA_INICIO}1:${SECCION_COLUMNA_FIN}500`;

const TITULO_SECCION: Record<"pagos_pendientes_alberto" | "deudas_pendientes", string> = {
  pagos_pendientes_alberto: "PAGOS PENDIENTES ALBERTO",
  deudas_pendientes: "DEUDAS PENDIENTES OTROS",
};

/**
 * Encuentra la primera fila EN BLANCO dentro de la sección pedida, sin
 * invadir la sección siguiente. Deliberadamente NUNCA inserta una fila
 * nueva (insertDimension): como las dos secciones comparten columnas con
 * TODOS los demás bloques de DATOS en la misma hoja, insertar una fila en
 * medio correría también las filas de Ingresos/Gastos Fijos/Pagos
 * Proyectos/etc. que están más abajo, aunque no tengan nada que ver —
 * solo escribe en huecos que ya existen. Si no hay hueco disponible, falla
 * explícitamente pidiendo que se amplíe el espacio a mano en el Sheet, en
 * vez de arriesgarse a invadir la sección de al lado.
 */
async function encontrarFilaDisponibleEnSeccion(
  seccion: "pagos_pendientes_alberto" | "deudas_pendientes"
): Promise<number> {
  const sheetId = assertSheetId();
  const sheets = getSheetsWriteClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: SECCION_RANGO_LECTURA,
    valueRenderOption: "FORMATTED_VALUE",
  });
  const rows = resp.data.values ?? [];

  const indiceDeTitulo = (titulo: string): number => {
    const idx = rows.findIndex((row) => String(row[0] ?? "").trim().toUpperCase() === titulo);
    if (idx === -1) throw new Error(`No se encontró la sección "${titulo}" en la hoja DATOS (columna ${SECCION_COLUMNA_INICIO}).`);
    return idx; // 0-indexado dentro de `rows`, que arranca en la fila 1 real
  };

  const idxAlberto = indiceDeTitulo(TITULO_SECCION.pagos_pendientes_alberto);
  const idxDeudas = indiceDeTitulo(TITULO_SECCION.deudas_pendientes);

  // Solo Alberto tiene un límite estricto real (el título de Deudas, que
  // nunca debe invadirse). Deudas es la ÚLTIMA sección conocida — la API de
  // Sheets trunca las filas vacías al final de un rango leído, así que
  // `rows.length` ahí NO es un límite real del Sheet, solo el final de lo
  // que se devolvió; escribir justo después de la última fila con datos es
  // seguro (no hay ninguna sección más abajo que proteger).
  const tieneLimiteEstricto = seccion === "pagos_pendientes_alberto";
  const idxInicio = tieneLimiteEstricto ? idxAlberto : idxDeudas;
  const idxTopeEscaneo = tieneLimiteEstricto ? idxDeudas : rows.length;

  let idxUltimoConDatos = idxInicio;
  for (let i = idxInicio + 1; i < idxTopeEscaneo; i++) {
    const cliente = String(rows[i]?.[0] ?? "").trim();
    if (cliente && cliente.toUpperCase() !== "CLIENTE") {
      idxUltimoConDatos = i;
    }
  }

  const idxDisponible = idxUltimoConDatos + 1;
  if (tieneLimiteEstricto && idxDisponible >= idxDeudas) {
    throw new Error(
      `No hay filas vacías disponibles en la sección "${TITULO_SECCION[seccion]}" de la hoja DATOS — agrega ` +
        `manualmente más espacio en blanco entre las secciones antes de continuar.`
    );
  }

  return idxDisponible + 1; // fila real 1-indexada
}

export interface NuevoPendiente {
  seccion: "pagos_pendientes_alberto" | "deudas_pendientes";
  cliente: string;
  /** Puede ir vacío — pedido explícito: estos pagos van sin semana mientras no se sepa cuándo se pagarán. */
  semana?: string;
  valor: number;
}

/**
 * Registra una fila nueva en Pagos Pendientes Alberto o Deudas Pendientes
 * Otros — a diferencia de registrarMovimientoEnSheet, la semana es opcional
 * (estos son saldos pendientes sin fecha de pago conocida) y no hay columna
 * de empresa (aplica al grupo, no a WOBA/EWORKS por separado).
 */
export async function registrarPendienteEnSheet(pendiente: NuevoPendiente): Promise<ResultadoEscritura> {
  const sheetId = assertSheetId();
  const sheets = getSheetsWriteClient();

  const fila = await encontrarFilaDisponibleEnSeccion(pendiente.seccion);
  const rango = `DATOS!${SECCION_COLUMNA_INICIO}${fila}:${SECCION_COLUMNA_FIN}${fila}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: rango,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[pendiente.cliente, pendiente.semana ?? "", pendiente.valor]] },
  });

  const verificacion = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: rango,
    valueRenderOption: "FORMATTED_VALUE",
  });

  const filaEscrita = verificacion.data.values?.[0];
  const valorEscrito = filaEscrita?.[2];

  if (!filaEscrita || valorEscrito === undefined || valorEscrito === "") {
    return {
      ok: false,
      mensaje:
        `Se intentó escribir en ${rango} pero la verificación de lectura no encontró el valor esperado. ` +
        "Revisa manualmente la hoja antes de reintentar.",
      fila,
      rango,
    };
  }

  return {
    ok: true,
    mensaje: `Movimiento registrado y verificado en ${rango}.`,
    fila,
    rango,
  };
}

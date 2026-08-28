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

export type BloqueEscritura = "ingresos" | "pagos_proyectos" | "pagos_extras" | "gastos_fijos";

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

const BLOQUE_CONFIG: Record<BloqueEscritura, BloqueColumnas> = {
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
};

const PRIMERA_FILA_DATOS = 6;
const ULTIMA_FILA_BUSQUEDA = 500;

/**
 * Busca la primera fila vacía (sin VALOR) dentro del bloque, a partir de la
 * fila 6, para escribir ahí una fila NUEVA sin pisar datos existentes.
 */
async function findNextEmptyRow(bloque: BloqueEscritura): Promise<number> {
  const sheetId = assertSheetId();
  const sheets = getSheetsWriteClient();
  const { columnaChequeo } = BLOQUE_CONFIG[bloque];

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `DATOS!${columnaChequeo}${PRIMERA_FILA_DATOS}:${columnaChequeo}${ULTIMA_FILA_BUSQUEDA}`,
    valueRenderOption: "FORMATTED_VALUE",
  });

  // La API de Sheets no devuelve filas vacías al final del rango (las trunca),
  // así que `values` solo cubre hasta la última fila con contenido. Un hueco
  // vacío ENTRE filas con datos sí se devuelve como fila []. Por eso:
  // - si hay un hueco real dentro de los datos devueltos, se usa ese;
  // - si no hay hueco, la siguiente fila vacía es la que sigue al final de
  //   lo devuelto (values.length), no un error.
  const values = resp.data.values ?? [];
  const offsetConHueco = values.findIndex((row) => !row[0] || String(row[0]).trim() === "");
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

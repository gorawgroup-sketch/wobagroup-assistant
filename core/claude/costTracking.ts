import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_costos_ia";
const HEADERS = [
  "fecha",
  "chatId",
  "modelo",
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
  "costoUSD",
  "proceso",
  "autenticacion",
  "ejecucionId",
  "llamadaNumero",
  "costoEquivalenteSuscripcionUSD",
  "gastoRealApiUSD",
];

// Tarifas oficiales por modelo (USD por token) — el sistema ahora enruta
// entre varios modelos (core/claude/client.ts), así que el costo ya no se
// puede calcular con una sola tarifa fija. Si se agrega o cambia un modelo,
// hay que actualizar esta tabla — si no, /costos_ia calcula con una tarifa
// que no corresponde al modelo real que respondió.
const PRECIOS_POR_MODELO: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 2.0 / 1_000_000, output: 10.0 / 1_000_000 },
  "claude-haiku-4-5": { input: 1.0 / 1_000_000, output: 5.0 / 1_000_000 },
  // Se conserva para el rollback configurable de los procesos documentales.
  "claude-sonnet-4-6": { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
};

// Tarifa de respaldo si algún día se usa un modelo que no está en la tabla
// de arriba — mejor sobreestimar (tarifa más cara conocida) que subestimar
// el costo real y no darse cuenta de un aumento de gasto.
const PRECIOS_POR_DEFECTO = PRECIOS_POR_MODELO["claude-sonnet-5"];

function obtenerPrecios(modelo: string): { input: number; output: number } {
  return PRECIOS_POR_MODELO[modelo] ?? PRECIOS_POR_DEFECTO;
}

// Bug real que esto evita repetir (mismo patrón que ya pasó con
// claude-sonnet-4-6, ver comentario arriba): la tool de búsqueda web
// (core/claude/client.ts, WEB_SEARCH_TOOL) se factura APARTE de los tokens
// normales — $10 USD cada 1.000 búsquedas, verificado en vivo contra la
// documentación oficial 2026-09-01 — y viene en un campo de `usage`
// separado (server_tool_use.web_search_requests) que calcularCostoUSD no
// leía. Sin esto, cada búsqueda real habría quedado invisible en
// /costos_ia — el mismo error de "esta llamada real no se registraba".
// Exportado para que webSearchLog.ts (registro independiente de cada
// búsqueda, con su query real) calcule el mismo costo por unidad sin
// duplicar el número y arriesgar que se desincronicen.
export const PRECIO_POR_BUSQUEDA_WEB = 10 / 1000;

export interface UsoAnthropic {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number } | null;
}

export function calcularCostoUSD(usage: UsoAnthropic, modelo: string): number {
  const { input: precioInput, output: precioOutput } = obtenerPrecios(modelo);
  // La escritura de caché cuesta 25% más que el input normal; la lectura de
  // caché cuesta 10% del input normal — misma proporción para todos los
  // modelos de Claude, solo cambia la tarifa base de la que parten.
  const precioCacheWrite = precioInput * 1.25;
  const precioCacheRead = precioInput * 0.1;

  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const busquedasWeb = usage.server_tool_use?.web_search_requests ?? 0;

  return (
    inputTokens * precioInput +
    outputTokens * precioOutput +
    cacheCreation * precioCacheWrite +
    cacheRead * precioCacheRead +
    busquedasWeb * PRECIO_POR_BUSQUEDA_WEB
  );
}

/**
 * Ahorro neto frente a enviar esos mismos tokens siempre como entrada nueva.
 * Puede ser negativo durante el calentamiento: crear caché cuesta un 25% adicional y solo compensa
 * cuando una llamada posterior la reutiliza. No incluye salida ni búsquedas porque no cambian.
 */
export function calcularAhorroNetoCacheUSD(
  cacheCreationTokens: number,
  cacheReadTokens: number,
  modelo: string
): number {
  const { input: precioInput } = obtenerPrecios(modelo);
  return cacheReadTokens * precioInput * 0.9 - cacheCreationTokens * precioInput * 0.25;
}

function assertSheetId(): string {
  if (!CASHFLOW_SHEET_ID) {
    throw new Error("Falta la variable de entorno CASHFLOW_SHEET_ID.");
  }
  return CASHFLOW_SHEET_ID;
}

let writeClient: sheets_v4.Sheets | null = null;
let tabAsegurada = false;

function getClient(): sheets_v4.Sheets {
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

async function ensureTab(): Promise<void> {
  if (tabAsegurada) return;

  const sheetId = assertSheetId();
  const sheets = getClient();

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: "sheets.properties" });
  const existing = meta.data.sheets?.find((s) => s.properties?.title === TAB_NAME);
  if (existing) {
    // Migración aditiva: las ocho columnas históricas conservan exactamente
    // su posición. Las nuevas solo añaden atribución y separación entre
    // valor equivalente y gasto real, sin guardar prompts ni resultados.
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${TAB_NAME}!A1:N1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADERS] },
    });
    tabAsegurada = true;
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: TAB_NAME, hidden: true } } }],
    },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:N1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabAsegurada = true;
}

/**
 * Registra el costo de UNA llamada a la API de Claude (cada iteración del
 * loop de tool-use en askClaude, no solo la respuesta final — cada una se
 * factura por separado). Se llama en "fire and forget" desde askClaude para
 * no añadir la latencia de escribir en Sheets a la respuesta del usuario.
 */
export type AutenticacionIA = "anthropic_api_key" | "claude_subscription" | "chatgpt_subscription";

export interface MetadatosUsoIA {
  proceso: string;
  autenticacion?: AutenticacionIA;
  ejecucionId?: string;
  llamadaNumero?: number;
}

export async function registrarUsoIA(
  chatId: number | undefined,
  modelo: string,
  usage: UsoAnthropic,
  metadata: MetadatosUsoIA = { proceso: "sin_atribuir" }
): Promise<void> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const costoUSD = calcularCostoUSD(usage, modelo);
  const autenticacion = metadata.autenticacion ?? "anthropic_api_key";
  const gastoRealApiUSD = autenticacion === "anthropic_api_key" ? costoUSD : 0;
  const costoEquivalenteSuscripcionUSD = autenticacion === "anthropic_api_key" ? 0 : costoUSD;

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:N`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [
        [
          new Date().toISOString(),
          chatId ?? "",
          modelo,
          usage.input_tokens ?? 0,
          usage.output_tokens ?? 0,
          usage.cache_creation_input_tokens ?? 0,
          usage.cache_read_input_tokens ?? 0,
          costoUSD,
          metadata.proceso,
          autenticacion,
          metadata.ejecucionId ?? "",
          metadata.llamadaNumero ?? 1,
          costoEquivalenteSuscripcionUSD,
          gastoRealApiUSD,
        ],
      ],
    },
  });
}

export interface ResumenCostos {
  llamadas: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  ahorroNetoCacheUSD: number;
  costoUSD: number;
  costoEquivalenteSuscripcionUSD: number;
  gastoRealApiUSD: number;
}

interface FilaUso {
  fecha: Date;
  modelo: string;
  costoUSD: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  ahorroNetoCacheUSD: number;
  proceso: string;
  autenticacion: string;
  ejecucionId: string;
  llamadaNumero: number;
  costoEquivalenteSuscripcionUSD: number;
  gastoRealApiUSD: number;
}

async function leerFilas(): Promise<FilaUso[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:N200000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  return rows
    .filter((row) => row[0])
    .map((row) => ({
      fecha: new Date(String(row[0])),
      modelo: String(row[2] || "modelo_desconocido"),
      inputTokens: Number(row[3]) || 0,
      outputTokens: Number(row[4]) || 0,
      cacheCreationTokens: Number(row[5]) || 0,
      cacheReadTokens: Number(row[6]) || 0,
      ahorroNetoCacheUSD: calcularAhorroNetoCacheUSD(
        Number(row[5]) || 0,
        Number(row[6]) || 0,
        String(row[2] || "modelo_desconocido")
      ),
      costoUSD: Number(row[7]) || 0,
      proceso: String(row[8] || "sin_atribuir"),
      autenticacion: String(row[9] || "anthropic_api_key"),
      ejecucionId: String(row[10] || ""),
      llamadaNumero: Number(row[11]) || 1,
      costoEquivalenteSuscripcionUSD: Number(row[12]) || 0,
      gastoRealApiUSD: row[13] === undefined ? Number(row[7]) || 0 : Number(row[13]) || 0,
    }));
}

export interface ResumenProcesoIA extends ResumenCostos {
  proceso: string;
}

export interface PuntoCostoDiario {
  fecha: string;
  llamadas: number;
  gastoRealApiUSD: number;
}

/**
 * Snapshot monetario para el panel de control diario. Se calcula desde una
 * sola lectura de `_costos_ia`: añadir gráficos o recomendaciones al front
 * no multiplica las consultas a Sheets ni invoca ningún modelo.
 */
export interface AnalisisCostosDiario {
  hoy: ResumenCostos;
  ayer: ResumenCostos;
  semanaActual: ResumenCostos;
  mesActual: ResumenCostos;
  ultimos7Dias: PuntoCostoDiario[];
  promedio7DiasPreviosUSD: number;
  umbralAnomaliaUSD: number;
  esAnomaliaAyer: boolean;
  proyeccionMensualUSD: number;
  porProcesoAyer: ResumenProcesoIA[];
  ejecucionesConMuchasLlamadasAyer: number;
}

function inicioDia(fecha: Date): Date {
  const resultado = new Date(fecha);
  resultado.setHours(0, 0, 0, 0);
  return resultado;
}

function sumarDias(fecha: Date, dias: number): Date {
  const resultado = new Date(fecha);
  resultado.setDate(resultado.getDate() + dias);
  return resultado;
}

function claveFechaLocal(fecha: Date): string {
  return `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, "0")}-${String(fecha.getDate()).padStart(2, "0")}`;
}

function resumirFilas(filas: FilaUso[]): ResumenCostos {
  return filas.reduce(
    (acc, fila) => ({
      llamadas: acc.llamadas + 1,
      inputTokens: acc.inputTokens + fila.inputTokens,
      outputTokens: acc.outputTokens + fila.outputTokens,
      cacheCreationTokens: acc.cacheCreationTokens + fila.cacheCreationTokens,
      cacheReadTokens: acc.cacheReadTokens + fila.cacheReadTokens,
      ahorroNetoCacheUSD: acc.ahorroNetoCacheUSD + fila.ahorroNetoCacheUSD,
      costoUSD: acc.costoUSD + fila.costoUSD,
      costoEquivalenteSuscripcionUSD:
        acc.costoEquivalenteSuscripcionUSD + fila.costoEquivalenteSuscripcionUSD,
      gastoRealApiUSD: acc.gastoRealApiUSD + fila.gastoRealApiUSD,
    }),
    {
      llamadas: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      ahorroNetoCacheUSD: 0,
      costoUSD: 0,
      costoEquivalenteSuscripcionUSD: 0,
      gastoRealApiUSD: 0,
    }
  );
}

function filasEnRango(filas: FilaUso[], desde: Date, hasta: Date): FilaUso[] {
  return filas.filter((fila) => fila.fecha >= desde && fila.fecha < hasta);
}

function resumirPorProceso(filas: FilaUso[]): ResumenProcesoIA[] {
  const porProceso = new Map<string, ResumenProcesoIA>();
  for (const fila of filas) {
    const actual = porProceso.get(fila.proceso) ?? {
      proceso: fila.proceso,
      llamadas: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      ahorroNetoCacheUSD: 0,
      costoUSD: 0,
      costoEquivalenteSuscripcionUSD: 0,
      gastoRealApiUSD: 0,
    };
    actual.llamadas++;
    actual.inputTokens += fila.inputTokens;
    actual.outputTokens += fila.outputTokens;
    actual.cacheCreationTokens += fila.cacheCreationTokens;
    actual.cacheReadTokens += fila.cacheReadTokens;
    actual.ahorroNetoCacheUSD += fila.ahorroNetoCacheUSD;
    actual.costoUSD += fila.costoUSD;
    actual.costoEquivalenteSuscripcionUSD += fila.costoEquivalenteSuscripcionUSD;
    actual.gastoRealApiUSD += fila.gastoRealApiUSD;
    porProceso.set(fila.proceso, actual);
  }
  return [...porProceso.values()].sort((a, b) => b.gastoRealApiUSD - a.gastoRealApiUSD);
}

export async function obtenerAnalisisCostosDiario(
  referencia: Date = new Date(),
  multiplicadorAnomalia = 2,
  maxLlamadasPorEjecucion = 12
): Promise<AnalisisCostosDiario> {
  const filas = await leerFilas();
  const hoyInicio = inicioDia(referencia);
  const mananaInicio = sumarDias(hoyInicio, 1);
  const ayerInicio = sumarDias(hoyInicio, -1);
  const semanaInicio = sumarDias(hoyInicio, -((hoyInicio.getDay() || 7) - 1));
  const mesInicio = new Date(hoyInicio.getFullYear(), hoyInicio.getMonth(), 1);

  const filasAyer = filasEnRango(filas, ayerInicio, hoyInicio);
  const ultimos7Dias = Array.from({ length: 7 }, (_, indice) => {
    const desde = sumarDias(hoyInicio, indice - 7);
    const hasta = sumarDias(desde, 1);
    const resumen = resumirFilas(filasEnRango(filas, desde, hasta));
    return {
      fecha: claveFechaLocal(desde),
      llamadas: resumen.llamadas,
      gastoRealApiUSD: resumen.gastoRealApiUSD,
    };
  });

  // La referencia excluye ayer: así un pico no eleva su propio promedio y
  // es más fácil detectar el cambio real frente a los siete días anteriores.
  const sieteDiasPrevios = Array.from({ length: 7 }, (_, indice) => {
    const desde = sumarDias(ayerInicio, indice - 7);
    return resumirFilas(filasEnRango(filas, desde, sumarDias(desde, 1))).gastoRealApiUSD;
  });
  const promedio7DiasPreviosUSD =
    sieteDiasPrevios.reduce((total, costo) => total + costo, 0) / sieteDiasPrevios.length;
  const umbralAnomaliaUSD = promedio7DiasPreviosUSD * multiplicadorAnomalia;

  const llamadasPorEjecucion = new Map<string, number>();
  for (const fila of filasAyer) {
    if (!fila.ejecucionId) continue;
    llamadasPorEjecucion.set(fila.ejecucionId, (llamadasPorEjecucion.get(fila.ejecucionId) ?? 0) + 1);
  }

  const mesActual = resumirFilas(filasEnRango(filas, mesInicio, mananaInicio));
  const diasDelMes = new Date(hoyInicio.getFullYear(), hoyInicio.getMonth() + 1, 0).getDate();
  const fraccionDia = Math.min(1, Math.max(0, (referencia.getTime() - hoyInicio.getTime()) / 86_400_000));
  const diasTranscurridos = Math.max(1, hoyInicio.getDate() - 1 + fraccionDia);

  return {
    hoy: resumirFilas(filasEnRango(filas, hoyInicio, mananaInicio)),
    ayer: resumirFilas(filasAyer),
    semanaActual: resumirFilas(filasEnRango(filas, semanaInicio, mananaInicio)),
    mesActual,
    ultimos7Dias,
    promedio7DiasPreviosUSD,
    umbralAnomaliaUSD,
    esAnomaliaAyer:
      promedio7DiasPreviosUSD > 0 &&
      resumirFilas(filasAyer).gastoRealApiUSD > umbralAnomaliaUSD,
    proyeccionMensualUSD: (mesActual.gastoRealApiUSD / diasTranscurridos) * diasDelMes,
    porProcesoAyer: resumirPorProceso(filasAyer),
    ejecucionesConMuchasLlamadasAyer: [...llamadasPorEjecucion.values()].filter(
      (llamadas) => llamadas > maxLlamadasPorEjecucion
    ).length,
  };
}

/** Atribución agregada sin exponer prompts, resultados, chat IDs ni secretos. */
export async function obtenerResumenPorProceso(desde: Date, hasta: Date): Promise<ResumenProcesoIA[]> {
  const filas = (await leerFilas()).filter((f) => f.fecha >= desde && f.fecha < hasta);
  const porProceso = new Map<string, ResumenProcesoIA>();

  for (const fila of filas) {
    const actual = porProceso.get(fila.proceso) ?? {
      proceso: fila.proceso,
      llamadas: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      ahorroNetoCacheUSD: 0,
      costoUSD: 0,
      costoEquivalenteSuscripcionUSD: 0,
      gastoRealApiUSD: 0,
    };
    actual.llamadas++;
    actual.inputTokens += fila.inputTokens;
    actual.outputTokens += fila.outputTokens;
    actual.cacheCreationTokens += fila.cacheCreationTokens;
    actual.cacheReadTokens += fila.cacheReadTokens;
    actual.ahorroNetoCacheUSD += fila.ahorroNetoCacheUSD;
    actual.costoUSD += fila.costoUSD;
    actual.costoEquivalenteSuscripcionUSD += fila.costoEquivalenteSuscripcionUSD;
    actual.gastoRealApiUSD += fila.gastoRealApiUSD;
    porProceso.set(fila.proceso, actual);
  }

  return [...porProceso.values()].sort((a, b) => b.gastoRealApiUSD - a.gastoRealApiUSD);
}

export interface DiagnosticoRepeticionesIA {
  ejecucionesConMuchasLlamadas: Array<{ ejecucionId: string; proceso: string; llamadas: number }>;
}

/** Detecta loops por ejecución usando solo metadatos; el contenido nunca se lee ni se registra. */
export async function diagnosticarRepeticionesIA(
  desde: Date,
  hasta: Date,
  maxLlamadasPorEjecucion = 12
): Promise<DiagnosticoRepeticionesIA> {
  const filas = (await leerFilas()).filter(
    (f) => f.fecha >= desde && f.fecha < hasta && Boolean(f.ejecucionId)
  );
  const grupos = new Map<string, { ejecucionId: string; proceso: string; llamadas: number }>();
  for (const fila of filas) {
    const actual = grupos.get(fila.ejecucionId) ?? {
      ejecucionId: fila.ejecucionId,
      proceso: fila.proceso,
      llamadas: 0,
    };
    actual.llamadas++;
    grupos.set(fila.ejecucionId, actual);
  }
  return {
    ejecucionesConMuchasLlamadas: [...grupos.values()].filter((g) => g.llamadas > maxLlamadasPorEjecucion),
  };
}

/** Resume el costo entre `desde` (inclusive) y `hasta` (exclusive). */
export async function obtenerResumenCostos(desde: Date, hasta: Date): Promise<ResumenCostos> {
  const filas = await leerFilas();
  const enRango = filas.filter((f) => f.fecha >= desde && f.fecha < hasta);

  return enRango.reduce(
    (acc, f) => ({
      llamadas: acc.llamadas + 1,
      inputTokens: acc.inputTokens + f.inputTokens,
      outputTokens: acc.outputTokens + f.outputTokens,
      cacheCreationTokens: acc.cacheCreationTokens + f.cacheCreationTokens,
      cacheReadTokens: acc.cacheReadTokens + f.cacheReadTokens,
      ahorroNetoCacheUSD: acc.ahorroNetoCacheUSD + f.ahorroNetoCacheUSD,
      costoUSD: acc.costoUSD + f.costoUSD,
      costoEquivalenteSuscripcionUSD:
        acc.costoEquivalenteSuscripcionUSD + f.costoEquivalenteSuscripcionUSD,
      gastoRealApiUSD: acc.gastoRealApiUSD + f.gastoRealApiUSD,
    }),
    {
      llamadas: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      ahorroNetoCacheUSD: 0,
      costoUSD: 0,
      costoEquivalenteSuscripcionUSD: 0,
      gastoRealApiUSD: 0,
    }
  );
}

/** Costo total por día, para los últimos `dias` días completos (excluye hoy). */
export async function obtenerCostoPorDia(dias: number, referencia: Date = new Date()): Promise<number[]> {
  const filas = await leerFilas();
  const hoyNorm = new Date(referencia.getFullYear(), referencia.getMonth(), referencia.getDate());

  const costos: number[] = [];
  for (let i = dias; i >= 1; i--) {
    const inicio = new Date(hoyNorm);
    inicio.setDate(inicio.getDate() - i);
    const fin = new Date(inicio);
    fin.setDate(fin.getDate() + 1);

    const total = filas
      .filter((f) => f.fecha >= inicio && f.fecha < fin)
      .reduce((acc, f) => acc + f.gastoRealApiUSD, 0);
    costos.push(total);
  }
  return costos;
}

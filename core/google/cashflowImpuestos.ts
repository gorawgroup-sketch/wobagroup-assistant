import { assertSheetId, getSheetsWriteClient, obtenerGridIdDatos, type ResultadoEscritura } from "./cashflowWrite";
import { invalidarCachesCashflow } from "./cashflowSheet";
import { conMutex } from "../utils/asyncMutex";
import { montosCercanos } from "../utils/montos";

/**
 * Escritor de las dos secciones de impuestos de la hoja DATOS, apiladas en las columnas N:Q bajo Pagos Proyectos:
 * «IMPUESTOS POR PAGAR» y «APLAZAMIENTO IMPUESTOS POR PAGAR» (IMPUESTO / SEMANA / VALOR / AÑO).
 *
 * Pedido de Carlos (2026-09-30), tras comparar el cashflow con el calendario de aplazamientos de la AEAT: faltaban
 * cuotas, importes sin intereses y semanas desfasadas, y estas secciones no tenían escritor (solo lector, ver
 * parsearSeccionesColumnaN en cashflowSheet.ts). Mismo contrato que el resto de escritores: nunca escribe fuera del
 * hueco calculado, verifica por relectura y falla explícitamente antes que invadir la sección de al lado.
 *
 * Verificado en vivo (2026-09-30): título en N25 y N45, cabecera dos filas después, datos a continuación. Las cuotas
 * pendientes de WOBA ya tienen fila preparada con el concepto puesto y semana/valor vacíos: una fila así se considera
 * disponible SOLO para ese mismo concepto.
 */
export type SeccionImpuestos = "impuestos_por_pagar" | "aplazamiento_impuestos";
export const TITULO_SECCION_IMPUESTOS: Record<SeccionImpuestos, string> = {
  impuestos_por_pagar: "IMPUESTOS POR PAGAR",
  aplazamiento_impuestos: "APLAZAMIENTO IMPUESTOS POR PAGAR",
};
const COLUMNA_INICIO = "N";
const COLUMNA_FIN = "Q";
const RANGO_LECTURA = `DATOS!${COLUMNA_INICIO}1:${COLUMNA_FIN}300`;
const IDX = { impuesto: 0, semana: 1, valor: 2, anio: 3 } as const;
const COLUMNA_VALOR_0 = 15; // P, 0-indexada, para el formato de moneda
const TOLERANCIA = 0.011;

export interface FilaImpuesto { fila: number; impuesto: string; semana: string; valor: string; anio: string }
export interface SeccionImpuestosLeida { filaTitulo: number; filaCabecera: number; filas: FilaImpuesto[]; filaLimite?: number }

/** Interpreta las filas crudas N1:Q… y localiza una sección. Pura, para poder probarla. */
export function interpretarSeccionImpuestos(rows: string[][], seccion: SeccionImpuestos): SeccionImpuestosLeida {
  const normal = (v: unknown) => String(v ?? "").trim().toUpperCase();
  const idxTitulo = rows.findIndex((r) => normal(r[IDX.impuesto]) === TITULO_SECCION_IMPUESTOS[seccion]);
  if (idxTitulo === -1) throw new Error(`No se encontró la sección "${TITULO_SECCION_IMPUESTOS[seccion]}" en la hoja DATOS (columna N).`);
  const idxCabecera = rows.findIndex((r, i) => i > idxTitulo && normal(r[IDX.impuesto]) === "IMPUESTO");
  if (idxCabecera === -1 || idxCabecera - idxTitulo > 4) throw new Error(`No se encontró la cabecera IMPUESTO/SEMANA/VALOR de "${TITULO_SECCION_IMPUESTOS[seccion]}".`);
  const otrosTitulos = Object.values(TITULO_SECCION_IMPUESTOS).concat(["PAGOS PROYECTOS"]);
  const idxSiguienteTitulo = rows.findIndex((r, i) => i > idxCabecera && otrosTitulos.includes(normal(r[IDX.impuesto])));
  const fin = idxSiguienteTitulo === -1 ? rows.length : idxSiguienteTitulo;
  const filas: FilaImpuesto[] = [];
  for (let i = idxCabecera + 1; i < fin; i++) {
    const r = rows[i] ?? [];
    filas.push({ fila: i + 1, impuesto: String(r[IDX.impuesto] ?? "").trim(), semana: String(r[IDX.semana] ?? "").trim(),
      valor: String(r[IDX.valor] ?? "").trim(), anio: String(r[IDX.anio] ?? "").trim() });
  }
  return { filaTitulo: idxTitulo + 1, filaCabecera: idxCabecera + 1, filas,
    filaLimite: idxSiguienteTitulo === -1 ? undefined : idxSiguienteTitulo + 1 };
}

/**
 * Fila donde escribir `impuesto`: (1) una fila preparada a mano con ese mismo concepto y sin valor; si no, (2) la
 * fila siguiente a la última con datos (concepto o valor). Nunca una fila con otro concepto, aunque no tenga valor.
 * En la última sección no hay tope; en las demás, el título de la siguiente sección. Pura.
 */
export function filaDisponibleImpuestos(seccion: SeccionImpuestosLeida, impuesto: string): number {
  const objetivo = impuesto.trim().toUpperCase();
  const preparada = seccion.filas.find((f) => f.valor === "" && f.impuesto.toUpperCase() === objetivo);
  if (preparada) return preparada.fila;
  const ocupadas = seccion.filas.filter((f) => f.valor !== "" || f.impuesto !== "");
  const candidata = (ocupadas.length ? ocupadas[ocupadas.length - 1].fila : seccion.filaCabecera) + 1;
  if (seccion.filaLimite !== undefined && candidata >= seccion.filaLimite) {
    throw new Error("No hay filas vacías disponibles en esa sección de impuestos de la hoja DATOS — añade espacio en blanco a mano antes de continuar.");
  }
  return candidata;
}

export interface NuevoImpuesto { seccion: SeccionImpuestos; impuesto: string; semana: string; valor: number; anio: string }

export async function leerSeccionImpuestos(seccion: SeccionImpuestos): Promise<SeccionImpuestosLeida> {
  const resp = await getSheetsWriteClient().spreadsheets.values.get({ spreadsheetId: assertSheetId(), range: RANGO_LECTURA, valueRenderOption: "FORMATTED_VALUE" });
  return interpretarSeccionImpuestos((resp.data.values ?? []) as string[][], seccion);
}

async function fijarFormatoMoneda(fila: number): Promise<void> {
  try {
    await getSheetsWriteClient().spreadsheets.batchUpdate({ spreadsheetId: assertSheetId(), requestBody: { requests: [{ repeatCell: {
      range: { sheetId: await obtenerGridIdDatos(), startRowIndex: fila - 1, endRowIndex: fila, startColumnIndex: COLUMNA_VALOR_0, endColumnIndex: COLUMNA_VALOR_0 + 1 },
      cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "[$€]#,##0.00" } } }, fields: "userEnteredFormat.numberFormat" } }] } });
  } catch (error) {
    console.error("[cashflowImpuestos] No se pudo fijar el formato de moneda (no crítico):", error);
  }
}

/** Escribe una fila de impuesto en el primer hueco válido de su sección y la verifica por relectura. */
export async function registrarImpuestoEnSheet(datos: NuevoImpuesto): Promise<ResultadoEscritura> {
  return conMutex("cashflowImpuestos", async () => {
    const seccion = await leerSeccionImpuestos(datos.seccion);
    const fila = filaDisponibleImpuestos(seccion, datos.impuesto);
    const rango = `DATOS!${COLUMNA_INICIO}${fila}:${COLUMNA_FIN}${fila}`;
    const sheets = getSheetsWriteClient();
    invalidarCachesCashflow();
    // RAW con número real: el año queda como texto y el valor como número (ver hallazgo en registrarPendienteEnSheet).
    await sheets.spreadsheets.values.update({ spreadsheetId: assertSheetId(), range: rango, valueInputOption: "RAW",
      requestBody: { values: [[datos.impuesto, datos.semana, datos.valor, datos.anio]] } });
    await fijarFormatoMoneda(fila);
    const leido = (await sheets.spreadsheets.values.get({ spreadsheetId: assertSheetId(), range: rango, valueRenderOption: "UNFORMATTED_VALUE" })).data.values?.[0] ?? [];
    const valorLeido = typeof leido[IDX.valor] === "number" ? leido[IDX.valor] : Number(leido[IDX.valor]);
    invalidarCachesCashflow();
    if (String(leido[IDX.impuesto] ?? "") !== datos.impuesto || String(leido[IDX.semana] ?? "") !== datos.semana || !montosCercanos(valorLeido, datos.valor, TOLERANCIA)) {
      return { ok: false, mensaje: `Se intentó escribir en ${rango} pero la relectura no coincide (${JSON.stringify(leido)}). Revisa la hoja antes de reintentar.`, fila, rango };
    }
    return { ok: true, mensaje: `Registrado y verificado en ${rango}.`, fila, rango };
  });
}

export interface EdicionImpuesto {
  fila: number;
  /** Lo que la fila debe tener ahora mismo; si cambió desde la propuesta, no se escribe. */
  esperado: { impuesto: string; semana?: string; valor?: number };
  nuevo: { semana?: string; valor?: number; anio?: string };
}

/** Corrige semana, valor o año de una fila YA existente, comprobando antes que sigue como cuando se propuso. */
export async function editarImpuestoEnSheet(edicion: EdicionImpuesto): Promise<ResultadoEscritura> {
  return conMutex("cashflowImpuestos", async () => {
    const sheets = getSheetsWriteClient();
    const rango = `DATOS!${COLUMNA_INICIO}${edicion.fila}:${COLUMNA_FIN}${edicion.fila}`;
    const leer = async () => (await sheets.spreadsheets.values.get({ spreadsheetId: assertSheetId(), range: rango, valueRenderOption: "UNFORMATTED_VALUE" })).data.values?.[0] ?? [];
    const actual = await leer();
    const valorActual = typeof actual[IDX.valor] === "number" ? actual[IDX.valor] : Number(actual[IDX.valor]);
    const impuestoActual = String(actual[IDX.impuesto] ?? "").trim();
    if (impuestoActual.toUpperCase() !== edicion.esperado.impuesto.trim().toUpperCase() ||
        (edicion.esperado.semana !== undefined && String(actual[IDX.semana] ?? "").trim() !== edicion.esperado.semana) ||
        (edicion.esperado.valor !== undefined && !montosCercanos(valorActual, edicion.esperado.valor, TOLERANCIA))) {
      return { ok: false, mensaje: `La fila ${edicion.fila} ya no es como cuando se propuso (ahora: ${JSON.stringify(actual)}); no la toqué.`, fila: edicion.fila, rango };
    }
    const valores = [
      impuestoActual,
      edicion.nuevo.semana ?? String(actual[IDX.semana] ?? ""),
      edicion.nuevo.valor ?? (Number.isFinite(valorActual) ? valorActual : String(actual[IDX.valor] ?? "")),
      edicion.nuevo.anio ?? String(actual[IDX.anio] ?? ""),
    ];
    invalidarCachesCashflow();
    await sheets.spreadsheets.values.update({ spreadsheetId: assertSheetId(), range: rango, valueInputOption: "RAW", requestBody: { values: [valores] } });
    if (edicion.nuevo.valor !== undefined) await fijarFormatoMoneda(edicion.fila);
    const despues = await leer();
    const valorDespues = typeof despues[IDX.valor] === "number" ? despues[IDX.valor] : Number(despues[IDX.valor]);
    invalidarCachesCashflow();
    if ((edicion.nuevo.semana !== undefined && String(despues[IDX.semana] ?? "") !== edicion.nuevo.semana) ||
        (edicion.nuevo.valor !== undefined && !montosCercanos(valorDespues, edicion.nuevo.valor, TOLERANCIA)) ||
        (edicion.nuevo.anio !== undefined && String(despues[IDX.anio] ?? "") !== edicion.nuevo.anio)) {
      return { ok: false, mensaje: `Se escribió en ${rango} pero la relectura no coincide (${JSON.stringify(despues)}). Revisa la hoja.`, fila: edicion.fila, rango };
    }
    return { ok: true, mensaje: `Corregido y verificado en ${rango}.`, fila: edicion.fila, rango };
  });
}

import { leerFilas, agregarFila, actualizarFila, type FilaCruda } from "../google/sheetsKeyValueStore";
import type { Poliza, EstadoPoliza, EstadoPago } from "./types";

/**
 * Registro real de pólizas de seguro (WOBA/EWORKS/Footprint y las que se
 * sumen), poblado a mano a partir de documentos originales y datos de
 * Holded — ver docs/wobi-seguros.md §5, §16, §18. Store nuevo sobre el
 * primitivo compartido `sheetsKeyValueStore.ts` (no se reimplementa el
 * patrón de escritura segura) — mismo spreadsheet que el resto de stores
 * "_xxx" (CASHFLOW_SHEET_ID), en una pestaña propia.
 */
const TAB_NAME = "_polizas_seguros";
const HEADERS = [
  "id",
  "empresa",
  "empresaHolded",
  "aseguradora",
  "correduria",
  "numeroPoliza",
  "tipoCobertura",
  "activoAsociado",
  "capitalAsegurado",
  "moneda",
  "franquicia",
  "prima",
  "periodicidad",
  "cuentaDeCargo",
  "fechaInicioVigencia",
  "fechaVencimiento",
  "estado",
  "estadoPago",
  "fuenteExtraccion",
  "notas",
  "rutaDocumento",
  "ultimaVerificacion",
];
const NUM_COLS = HEADERS.length;

export interface PolizaConFila extends Poliza {
  rowIndex: number;
}

function filaAPoliza(fila: FilaCruda): PolizaConFila {
  const [
    id,
    empresa,
    empresaHolded,
    aseguradora,
    correduria,
    numeroPoliza,
    tipoCobertura,
    activoAsociado,
    capitalAsegurado,
    moneda,
    franquicia,
    prima,
    periodicidad,
    cuentaDeCargo,
    fechaInicioVigencia,
    fechaVencimiento,
    estado,
    estadoPago,
    fuenteExtraccion,
    notas,
    rutaDocumento,
    ultimaVerificacion,
  ] = fila.valores;

  return {
    rowIndex: fila.rowIndex,
    id,
    empresa,
    empresaHolded,
    aseguradora,
    correduria,
    numeroPoliza,
    tipoCobertura,
    activoAsociado,
    capitalAsegurado,
    moneda,
    franquicia,
    prima,
    periodicidad,
    cuentaDeCargo,
    fechaInicioVigencia,
    fechaVencimiento,
    estado: (estado || "pendiente_confirmacion") as EstadoPoliza,
    estadoPago: (estadoPago || "sin_confirmar") as EstadoPago,
    fuenteExtraccion,
    notas,
    rutaDocumento,
    ultimaVerificacion,
  };
}

function polizaAFila(p: Poliza): (string | number)[] {
  return [
    p.id,
    p.empresa,
    p.empresaHolded,
    p.aseguradora,
    p.correduria,
    p.numeroPoliza,
    p.tipoCobertura,
    p.activoAsociado,
    p.capitalAsegurado,
    p.moneda,
    p.franquicia,
    p.prima,
    p.periodicidad,
    p.cuentaDeCargo,
    p.fechaInicioVigencia,
    p.fechaVencimiento,
    p.estado,
    p.estadoPago,
    p.fuenteExtraccion,
    p.notas,
    p.rutaDocumento,
    p.ultimaVerificacion,
  ];
}

export async function listarPolizas(): Promise<PolizaConFila[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  return filas.map(filaAPoliza);
}

export async function listarPolizasPorEmpresa(empresa: string): Promise<PolizaConFila[]> {
  const todas = await listarPolizas();
  return todas.filter((p) => p.empresa === empresa);
}

export async function registrarPoliza(p: Poliza): Promise<void> {
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, polizaAFila(p));
}

export async function actualizarPoliza(rowIndex: number, p: Poliza): Promise<void> {
  await actualizarFila(TAB_NAME, rowIndex, NUM_COLS, polizaAFila(p));
}

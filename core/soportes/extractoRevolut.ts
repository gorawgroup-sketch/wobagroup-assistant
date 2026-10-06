/**
 * Lectura del CSV de movimientos de Revolut Business («transaction-statement_…csv»). Pura: sin red ni disco.
 *
 * El extracto es la ÚNICA fuente que dice quién gastó: Holded no guarda el titular de la tarjeta (verificado en vivo
 * 2026-10-06: un movimiento solo trae fecha, importe, descripción y estado). Las columnas que importan son `Payer`
 * (titular), `Card number` (enmascarado) y `Card label`.
 */

export interface FilaExtracto {
  id: string;
  tipo: string;
  estado: string;
  /** Fecha de liquidación en hora de Madrid (YYYY-MM-DD). */
  fecha: string;
  /** Fecha de inicio de la operación (YYYY-MM-DD); puede anteceder a la de liquidación. */
  fechaInicio: string;
  comercio: string;
  titular: string;
  tarjeta4: string;
  etiquetaTarjeta: string;
  /** Importe original del comercio (positivo) y su moneda. */
  importeOriginal: number;
  monedaOriginal: string;
  /** Importe debitado en la cuenta, con signo, ya con la comisión (columna «Total amount»). */
  total: number;
  monedaCuenta: string;
  comision: number;
  /** Cuenta de Revolut tal como la nombra el extracto («EUR Main»). */
  cuenta: string;
  /** Número de fila en el CSV (1 = cabecera) para poder citarla. */
  lineaCsv: number;
}

const COLUMNAS_REQUERIDAS = ["Type", "State", "Description", "Payer", "Card number", "Total amount", "Account"];

/** Divide un CSV respetando comillas y comas/saltos de línea dentro de ellas. */
export function parsearCsv(texto: string): string[][] {
  const filas: string[][] = [];
  let fila: string[] = [];
  let campo = "";
  let entreComillas = false;
  const limpio = texto.replace(/^﻿/, "");
  for (let i = 0; i < limpio.length; i++) {
    const c = limpio[i];
    if (entreComillas) {
      if (c === '"') {
        if (limpio[i + 1] === '"') { campo += '"'; i++; } else entreComillas = false;
      } else campo += c;
    } else if (c === '"') entreComillas = true;
    else if (c === ",") { fila.push(campo); campo = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && limpio[i + 1] === "\n") i++;
      fila.push(campo); campo = "";
      if (fila.some((x) => x !== "")) filas.push(fila);
      fila = [];
    } else campo += c;
  }
  fila.push(campo);
  if (fila.some((x) => x !== "")) filas.push(fila);
  return filas;
}

/** ¿Es un extracto de movimientos de Revolut Business? Se decide por las columnas, no por el nombre del archivo. */
export function esExtractoRevolut(texto: string): boolean {
  const cabecera = parsearCsv(texto.slice(0, 4000).split(/\r?\n/)[0] ?? "")[0] ?? [];
  return COLUMNAS_REQUERIDAS.every((c) => cabecera.includes(c));
}

const numero = (t: string | undefined): number => {
  const n = Number((t ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};
const soloDia = (t: string | undefined): string => (t ?? "").slice(0, 10);

export function parsearExtractoRevolut(texto: string): FilaExtracto[] {
  const filas = parsearCsv(texto);
  if (filas.length < 2) return [];
  const cab = filas[0];
  const idx = (nombre: string) => cab.indexOf(nombre);
  const col = (f: string[], nombre: string) => (idx(nombre) >= 0 ? (f[idx(nombre)] ?? "").trim() : "");
  if (!COLUMNAS_REQUERIDAS.every((c) => cab.includes(c))) return [];
  return filas.slice(1).map((f, i) => ({
    id: col(f, "ID"),
    tipo: col(f, "Type"),
    estado: col(f, "State"),
    fecha: soloDia(col(f, "Date completed (Europe/Madrid)") || col(f, "Date completed (UTC)")),
    fechaInicio: soloDia(col(f, "Date started (Europe/Madrid)") || col(f, "Date started (UTC)")),
    comercio: col(f, "Description"),
    titular: col(f, "Payer"),
    tarjeta4: col(f, "Card number").slice(-4),
    etiquetaTarjeta: col(f, "Card label"),
    importeOriginal: Math.abs(numero(col(f, "Orig amount"))),
    monedaOriginal: col(f, "Orig currency").toUpperCase(),
    total: numero(col(f, "Total amount")),
    monedaCuenta: (col(f, "Payment currency") || col(f, "Fee currency")).toUpperCase(),
    comision: numero(col(f, "Fee")),
    cuenta: col(f, "Account"),
    lineaCsv: i + 2,
  }));
}

/** Pagos con tarjeta ya liquidados: lo único a lo que se le pide soporte a quien lo gastó. */
export function esPagoConTarjeta(f: FilaExtracto): boolean {
  return f.tipo === "CARD_PAYMENT" && f.estado === "COMPLETED" && f.total < 0;
}

export function periodoDelExtracto(filas: FilaExtracto[]): { desde: string; hasta: string } | undefined {
  const fechas = filas.map((f) => f.fecha).filter(Boolean).sort();
  return fechas.length ? { desde: fechas[0], hasta: fechas[fechas.length - 1] } : undefined;
}

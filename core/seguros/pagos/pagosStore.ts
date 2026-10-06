import { agregarFila, actualizarFila, leerFilas, type FilaCruda } from "../../google/sheetsKeyValueStore";
import type { Empresa } from "../../holded/client";
import { pagosSembrados } from "./semilla";
import type { EstadoPagoCalendario, FormaPago, PagoSeguro, PagoSeguroConFila } from "./tipos";

/** Pestaña `_pagos_seguros`: el calendario de pagos de seguros (una fila por pago). Se siembra sola la primera vez. */
const TAB_NAME = "_pagos_seguros";
const HEADERS = [
  "id", "polizaId", "empresa", "fecha", "importe", "moneda", "estimado", "concepto", "cuentaDeCargo", "forma", "estado",
  "recurrenciaMeses", "eventoCalendarId", "avisos", "notas", "actualizadoEn",
];
const NUM_COLS = HEADERS.length;

const ESTADOS: readonly EstadoPagoCalendario[] = ["previsto", "pagado", "devuelto", "cancelado"];
const FORMAS: readonly FormaPago[] = ["adeudo", "transferencia", "desconocida"];
const EMPRESAS: readonly Empresa[] = ["WOBA", "EWORKS", "Footprint"];

export function pagoAFila(p: PagoSeguro): (string | number)[] {
  return [
    p.id, p.polizaId, p.empresa, p.fecha, p.importe, p.moneda, p.estimado ? "si" : "no", p.concepto, p.cuentaDeCargo, p.forma, p.estado,
    p.recurrenciaMeses, p.eventoCalendarId, p.avisos, p.notas, p.actualizadoEn,
  ];
}

/** null si la fila no es un pago válido (una fila a medias o editada a mano no rompe la lectura: se ignora). */
export function filaAPago(fila: FilaCruda): PagoSeguroConFila | null {
  const [id, polizaId, empresa, fecha, importe, moneda, estimado, concepto, cuentaDeCargo, forma, estado, recurrencia, evento, avisos, notas, actualizadoEn] = fila.valores;
  const importeNum = Number(String(importe ?? "").replace(",", "."));
  if (!id || !polizaId || !/^\d{4}-\d{2}-\d{2}$/.test(fecha ?? "") || !Number.isFinite(importeNum)) return null;
  if (!EMPRESAS.includes(empresa as Empresa) || !ESTADOS.includes(estado as EstadoPagoCalendario)) return null;
  return {
    id, polizaId, empresa: empresa as Empresa, fecha, importe: importeNum, moneda: (moneda || "EUR").toUpperCase(), estimado: (estimado ?? "").toLowerCase() === "si",
    concepto: concepto ?? "", cuentaDeCargo: cuentaDeCargo ?? "", forma: FORMAS.includes(forma as FormaPago) ? (forma as FormaPago) : "desconocida",
    estado: estado as EstadoPagoCalendario, recurrenciaMeses: Math.max(0, Math.round(Number(recurrencia) || 0)), eventoCalendarId: evento ?? "",
    avisos: avisos ?? "", notas: notas ?? "", actualizadoEn: actualizadoEn ?? "", rowIndex: fila.rowIndex,
  };
}

let sembrando: Promise<void> | null = null;

/** Lee el calendario; si no hay ninguna fila (primer uso) lo siembra con los pagos que ya constan. La siembra es idempotente por id. */
export async function leerPagosSeguros(): Promise<PagoSeguroConFila[]> {
  const leer = async () => (await leerFilas(TAB_NAME, NUM_COLS, HEADERS)).map(filaAPago).filter((p): p is PagoSeguroConFila => p !== null);
  const actual = await leer();
  if (actual.length > 0) return actual;
  if (!sembrando) {
    sembrando = (async () => {
      const existentes = new Set((await leer()).map((p) => p.id));
      for (const p of pagosSembrados(new Date().toISOString())) if (!existentes.has(p.id)) await agregarFila(TAB_NAME, NUM_COLS, HEADERS, pagoAFila(p));
    })().finally(() => { sembrando = null; });
  }
  await sembrando;
  return leer();
}

/** Añade un pago nuevo (p. ej. el siguiente de una serie) salvo que ya exista ese id. */
export async function agregarPagoSeguro(p: PagoSeguro): Promise<boolean> {
  if ((await leerPagosSeguros()).some((x) => x.id === p.id)) return false;
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, pagoAFila(p));
  return true;
}

/** Actualiza una fila en su sitio (por su número de fila actual). */
export async function actualizarPagoSeguro(p: PagoSeguroConFila, cambios: Partial<PagoSeguro>): Promise<PagoSeguroConFila> {
  const nuevo: PagoSeguroConFila = { ...p, ...cambios, actualizadoEn: new Date().toISOString() };
  await actualizarFila(TAB_NAME, p.rowIndex, NUM_COLS, pagoAFila(nuevo));
  return nuevo;
}

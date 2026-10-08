import type { PagoSeguro } from "./tipos";

/** Un pago de prueba (no se exporta nada de producción: solo ayuda a las pruebas de esta carpeta). */
export function pago(parcial: Partial<PagoSeguro> = {}): PagoSeguro {
  return {
    id: "woba_showroom_2026_2027:2027-03-01", polizaId: "woba_showroom_2026_2027", empresa: "WOBA", fecha: "2027-03-01", importe: 955, moneda: "EUR", estimado: true,
    concepto: "Allianz showroom 054239034 — 2.ª cuota semestral 2026/27", cuentaDeCargo: "BBVA", forma: "adeudo", estado: "previsto", recurrenciaMeses: 6,
    eventoCalendarId: "", avisos: "", notas: "", actualizadoEn: "2026-10-06T00:00:00.000Z", ...parcial,
  };
}

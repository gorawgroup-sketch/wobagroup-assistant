import type { PagoSeguro } from "./tipos";

type Semilla = Omit<PagoSeguro, "id" | "estado" | "eventoCalendarId" | "avisos" | "actualizadoEn">;

/**
 * Los pagos futuros que ya constan (06-10-2026), sacados de las notas del registro y de lo que dicen Acodrid y Markel. Todos son
 * estimaciones hasta que llegue el recibo real: se marcan `estimado` y así lo dicen los avisos. La cuenta de cargo es el nombre
 * EXACTO de la cuenta en Holded desde la que se cobró el último recibo de cada póliza (comprobado en el banco).
 *
 * Solo se siembran los pagos que las notas citan expresamente; los siguientes de cada serie los genera la recurrencia cuando
 * el vigilante confirma el pago anterior (por eso no está aquí el de septiembre de 2027 de Allianz).
 */
export const PAGOS_INICIALES: readonly Semilla[] = [
  {
    polizaId: "eworks_rc_markel", empresa: "EWORKS", fecha: "2027-02-27", importe: 840.74, moneda: "EUR", estimado: true,
    concepto: "RC Markel 025S00287RCG — 1.ª cuota semestral de la renovación 2027", cuentaDeCargo: "CAIXA BANK EWORKS", forma: "adeudo", recurrenciaMeses: 6,
    notas: "Dos cuotas semestrales (27/02 y 27/08), ~1.679 €/año; Markel avisa el importe exacto por carta de pago hacia la fecha. En 2026 se cobraron 840,94 € el 10/04 y 838,41 € el 15/09.",
  },
  {
    polizaId: "eworks_rc_markel", empresa: "EWORKS", fecha: "2027-08-27", importe: 838.41, moneda: "EUR", estimado: true,
    concepto: "RC Markel 025S00287RCG — 2.ª cuota semestral de la renovación 2027", cuentaDeCargo: "CAIXA BANK EWORKS", forma: "adeudo", recurrenciaMeses: 6,
    notas: "Segunda cuota de la serie; importe igual a la última cobrada (838,41 €).",
  },
  {
    polizaId: "woba_showroom_2026_2027", empresa: "WOBA", fecha: "2027-03-01", importe: 955, moneda: "EUR", estimado: true,
    concepto: "Allianz showroom 054239034 — 2.ª cuota semestral 2026/27", cuentaDeCargo: "BBVA", forma: "adeudo", recurrenciaMeses: 6,
    notas: "Importe por confirmar con Acodrid (en el ciclo anterior fueron 955,73 € y 903,11 €). Si el banco devuelve el adeudo, Acodrid pide transferencia.",
  },
  {
    polizaId: "woba_showroom_complemento_2026_2027", empresa: "WOBA", fecha: "2027-03-01", importe: 289.14, moneda: "EUR", estimado: true,
    concepto: "Allianz showroom — complemento por ampliación (Rental Code), recibo 01/03–01/09/2027", cuentaDeCargo: "BBVA", forma: "adeudo", recurrenciaMeses: 6,
    notas: "El suplemento llega hasta el 01/03/2027; el recibo siguiente se estima como el último (289,14 €) hasta que Acodrid confirme el importe.",
  },
  {
    polizaId: "woba_rc_markel", empresa: "WOBA", fecha: "2027-04-17", importe: 2012.65, moneda: "EUR", estimado: true,
    concepto: "RC Markel 023S00453RCG — renovación 2027/28", cuentaDeCargo: "BBVA", forma: "adeudo", recurrenciaMeses: 12,
    notas: "Con la actividad de alquiler de pantallas incluida (suplemento 3.3) la prima es «mínima y de depósito» (≈ 2.012,65 € brutos al año): puede haber regularización según la facturación. Confirmar con Acodrid antes de la renovación.",
  },
  {
    polizaId: "footprint_rc_markel", empresa: "Footprint", fecha: "2027-08-25", importe: 1671.03, moneda: "EUR", estimado: true,
    concepto: "RC profesional Markel 026S00905RCP — renovación 2027/28 (pago único)", cuentaDeCargo: "Main", forma: "adeudo", recurrenciaMeses: 12,
    notas: "En 2026 se cobraron 1.671,03 € el 27/08 en la cuenta Main (Revolut).",
  },
];

export const idPago = (polizaId: string, fecha: string): string => `${polizaId}:${fecha}`;

/** Los pagos sembrados, con su estado inicial. */
export function pagosSembrados(ahora: string): PagoSeguro[] {
  return PAGOS_INICIALES.map((s) => ({ ...s, id: idPago(s.polizaId, s.fecha), estado: "previsto", eventoCalendarId: "", avisos: "", actualizadoEn: ahora }));
}

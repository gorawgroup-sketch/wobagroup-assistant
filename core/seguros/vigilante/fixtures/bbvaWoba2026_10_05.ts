import type { MovimientoBanco } from "../tipos";

function mov(id: string, fecha: string, importe: number, saldoTras: number | null, descripcion = id): MovimientoBanco {
  return { empresa: "WOBA", cuentaId: "bbva", cuenta: "BBVA", id, fecha, descripcion, importe, moneda: "EUR", importeEur: importe, estado: "pending", saldoTras };
}

/**
 * Movimientos REALES de la cuenta BBVA de WOBA en Holded, 25/08 → 05/10/2026 (importes y saldos tal cual los trae
 * Holded; los ids son etiquetas legibles). Incluye los dos adeudos del 01/09 que el banco devolvió (Allianz y Aegon)
 * y el adeudo de Markel del 05/10 que el saldo aún no refleja.
 */
export const BBVA_REAL: MovimientoBanco[] = [
  mov("amortizacion_31_08", "2026-08-31", -5847.62, 160.03),
  mov("pagos_mensuales_31_08", "2026-08-31", 8600, 6007.65),
  mov("tgss_31_08", "2026-08-31", -2666.17, -2592.35),
  mov("allianz_01_09", "2026-09-01", -1016.86, -1222.33, "ALLIANZ SEGUROS Y REASEGUROS ADEUDO"),
  mov("aegon_01_09", "2026-09-01", -234.41, -205.47, "AEGON ESPANA ADEUDO DE SEGUROS"),
  mov("aliseda_01_09", "2026-09-01", -36.2, 28.94),
  mov("telefonica_a_01_09", "2026-09-01", -62.22, 65.14),
  mov("telefonica_b_01_09", "2026-09-01", -32.67, 127.36),
  mov("traspaso_02_09", "2026-09-02", 1300, 1328.94, "Transferencia propia seguro resp. civil"),
  mov("tarjeta_04_09", "2026-09-04", -38.31, 1290.63),
  mov("culligan_04_09", "2026-09-04", -120.69, 1169.94),
  mov("transferencia_07_09", "2026-09-07", -500, 669.94),
  mov("iberdrola_08_09", "2026-09-08", -264.46, 405.48),
  mov("aegon_09_09", "2026-09-09", -234.41, 171.07, "AEGON ESPANA ADEUDO DE SEGUROS"),
  mov("traspaso_16_09", "2026-09-16", 1900, 2071.07),
  mov("conversia_17_09", "2026-09-17", -445.69, 1625.38),
  mov("impuestos_21_09", "2026-09-21", -373.37, 1764.29),
  mov("entre_empresa_21_09", "2026-09-21", -2000, 2137.66),
  mov("comision_21_09", "2026-09-21", -2, 4137.66),
  mov("cobro_21_09", "2026-09-21", 2783, 4139.66),
  mov("telefonica_fija_21_09", "2026-09-21", -210.63, 1356.66),
  mov("renting_21_09", "2026-09-21", -58.09, 1567.29),
  mov("traspaso_29_09", "2026-09-29", 1300, 3064.29),
  mov("amortizacion_30_09", "2026-09-30", -5847.62, 319.13),
  mov("prestamo_30_09", "2026-09-30", 6000, 6166.75),
  mov("tgss_a_30_09", "2026-09-30", -329.38, 166.75),
  mov("tgss_b_30_09", "2026-09-30", -2568.16, 496.13),
  mov("impuestos_01_10", "2026-10-01", -255.2, 44.65),
  mov("sobregiro_01_10", "2026-10-01", 350, 299.85),
  mov("aegon_01_10", "2026-10-01", -234.41, -50.15, "AEGON ESPANA ADEUDO DE SEGUROS"),
  mov("aliseda_01_10", "2026-10-01", -36.2, 184.26),
  mov("telefonica_a_01_10", "2026-10-01", -66, 220.46),
  mov("telefonica_b_01_10", "2026-10-01", -32.67, 286.46),
  mov("sobregiro_05_10", "2026-10-05", 600, 804.85),
  mov("cobro_05_10", "2026-10-05", 160.2, 204.85),
  mov("markel_05_10", "2026-10-05", -323.24, -399.28, "Markel Insurance SE ADEUDO A SU CARGO"),
  mov("culligan_05_10", "2026-10-05", -120.69, -76.04),
];

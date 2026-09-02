import cron from "node-cron";
import { revisarHoldedVsCashflow } from "./revisarHoldedVsCashflow";
import { revisarAlertasFiscales } from "./revisarAlertasFiscales";
import { revisarCorreoNuevo } from "./revisarCorreoNuevo";
import { revisarCostosIA } from "./revisarCostosIA";
import { revisarNumeracionCashflow } from "./revisarNumeracionCashflow";
import { revisarAplazamientoImpuestos } from "./revisarAplazamientoImpuestos";
import { revisarAnotacionesCashflow } from "./revisarAnotacionesCashflow";
import { revisarAccionesProgramadas } from "./revisarAccionesProgramadas";

const TIMEZONE = "Europe/Madrid";

/**
 * Registra los crons del sistema. La mayoría son de solo lectura/notificación
 * — ninguno escribe en Holded/cashflow/correo sin aprobación explícita. La
 * excepción es revisarAccionesProgramadas: SÍ actúa por su cuenta cuando le
 * toca (pedido explícito de Carlos, "WOBI debe encargarse"), pero solo sobre
 * acciones que un humano ya pidió programar — y cualquier escritura real que
 * termine haciendo falta sigue pasando por su propio flujo de propuesta+botón.
 */
export function startScheduler(): void {
  cron.schedule(
    "0 8 * * 1",
    () => {
      revisarHoldedVsCashflow(new Date(), "semana_cerrada").catch((error) => {
        console.error("[scheduler] Error ejecutando revisarHoldedVsCashflow (cierre semanal):", error);
      });
    },
    { timezone: TIMEZONE }
  );
  console.log(`[scheduler] revisarHoldedVsCashflow (cierre semanal) programado: lunes 8:00 (${TIMEZONE})`);

  cron.schedule(
    "0 17 * * 5",
    () => {
      revisarHoldedVsCashflow(new Date(), "semana_en_curso").catch((error) => {
        console.error("[scheduler] Error ejecutando revisarHoldedVsCashflow (chequeo preliminar viernes):", error);
      });
    },
    { timezone: TIMEZONE }
  );
  console.log(`[scheduler] revisarHoldedVsCashflow (chequeo preliminar) programado: viernes 17:00 (${TIMEZONE})`);

  cron.schedule(
    "0 8 * * *",
    () => {
      revisarAlertasFiscales().catch((error) => {
        console.error("[scheduler] Error ejecutando revisarAlertasFiscales:", error);
      });
    },
    { timezone: TIMEZONE }
  );
  console.log(`[scheduler] revisarAlertasFiscales programado: diario 8:00 (${TIMEZONE})`);

  cron.schedule(
    "0 * * * *",
    () => {
      revisarCorreoNuevo().catch((error) => {
        console.error("[scheduler] Error ejecutando revisarCorreoNuevo:", error);
      });
    },
    { timezone: TIMEZONE }
  );
  console.log(`[scheduler] revisarCorreoNuevo programado: cada hora (${TIMEZONE})`);

  cron.schedule(
    "30 8 * * *",
    () => {
      revisarCostosIA().catch((error) => {
        console.error("[scheduler] Error ejecutando revisarCostosIA:", error);
      });
    },
    { timezone: TIMEZONE }
  );
  console.log(`[scheduler] revisarCostosIA programado: diario 8:30 (${TIMEZONE})`);

  cron.schedule(
    "15 8 * * *",
    () => {
      revisarNumeracionCashflow().catch((error) => {
        console.error("[scheduler] Error ejecutando revisarNumeracionCashflow:", error);
      });
    },
    { timezone: TIMEZONE }
  );
  console.log(`[scheduler] revisarNumeracionCashflow programado: diario 8:15 (${TIMEZONE})`);

  cron.schedule(
    "10 8 * * *",
    () => {
      revisarAplazamientoImpuestos().catch((error) => {
        console.error("[scheduler] Error ejecutando revisarAplazamientoImpuestos:", error);
      });
    },
    { timezone: TIMEZONE }
  );
  console.log(`[scheduler] revisarAplazamientoImpuestos programado: diario 8:10 (${TIMEZONE})`);

  cron.schedule(
    "20 8 * * *",
    () => {
      revisarAnotacionesCashflow().catch((error) => {
        console.error("[scheduler] Error ejecutando revisarAnotacionesCashflow:", error);
      });
    },
    { timezone: TIMEZONE }
  );
  console.log(`[scheduler] revisarAnotacionesCashflow programado: diario 8:20 (${TIMEZONE})`);

  cron.schedule(
    "5 * * * *",
    () => {
      revisarAccionesProgramadas().catch((error) => {
        console.error("[scheduler] Error ejecutando revisarAccionesProgramadas:", error);
      });
    },
    { timezone: TIMEZONE }
  );
  console.log(`[scheduler] revisarAccionesProgramadas programado: cada hora, minuto 5 (${TIMEZONE})`);
}

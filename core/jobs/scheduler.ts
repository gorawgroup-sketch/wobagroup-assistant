import cron from "node-cron";
import { revisarHoldedVsCashflow } from "./revisarHoldedVsCashflow";
import { revisarAlertasFiscales } from "./revisarAlertasFiscales";
import { revisarCorreoNuevo } from "./revisarCorreoNuevo";
import { revisarCostosIA } from "./revisarCostosIA";
import { revisarNumeracionCashflow } from "./revisarNumeracionCashflow";

const TIMEZONE = "Europe/Madrid";

/**
 * Registra los crons del sistema. Todos son de solo lectura/notificación —
 * ninguno escribe/actúa nada por su cuenta sin aprobación explícita.
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
}

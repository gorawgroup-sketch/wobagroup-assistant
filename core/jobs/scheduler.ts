import cron from "node-cron";
import { revisarHoldedVsCashflow } from "./revisarHoldedVsCashflow";
import { revisarAlertasFiscales } from "./revisarAlertasFiscales";
import { revisarCorreoNuevo } from "./revisarCorreoNuevo";

const TIMEZONE = "Europe/Madrid";

/**
 * Registra los crons del sistema. Todos son de solo lectura/notificación —
 * ninguno escribe/actúa nada por su cuenta sin aprobación explícita.
 */
export function startScheduler(): void {
  cron.schedule(
    "0 8 * * 1",
    () => {
      revisarHoldedVsCashflow().catch((error) => {
        console.error("[scheduler] Error ejecutando revisarHoldedVsCashflow:", error);
      });
    },
    { timezone: TIMEZONE }
  );
  console.log(`[scheduler] revisarHoldedVsCashflow programado: lunes 8:00 (${TIMEZONE})`);

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
}

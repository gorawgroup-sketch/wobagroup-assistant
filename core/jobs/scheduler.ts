import cron from "node-cron";
import { revisarHoldedVsCashflow } from "./revisarHoldedVsCashflow";

const TIMEZONE = "Europe/Madrid";

/**
 * Registra el cron semanal (lunes 8:00 Europe/Madrid). Solo detecta y notifica
 * por Telegram — nunca escribe en la hoja por su cuenta.
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
}

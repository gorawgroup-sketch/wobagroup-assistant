import { modoAutomatizacion } from "./modo";
import { registrarClasificacionDocumento, type SenalesDocumento } from "./tickets";
import { almacenTrabajosHolded } from "./trabajos";
import type { Empresa } from "../client";

/**
 * Enlace con el flujo de creación de gastos. Nunca lanza ni retrasa la creación: si la automatización está apagada
 * no hace nada, y cualquier fallo se registra y se ignora (la clasificación es un complemento, no parte del gasto).
 */
export function registrarClasificacionTicketNoCritico(entrada: { empresa: Empresa; compraId: string } & SenalesDocumento): Promise<void> {
  if (modoAutomatizacion("TICKETS") === "apagado" || !entrada.compraId) return Promise.resolve();
  return registrarClasificacionDocumento(almacenTrabajosHolded(), entrada)
    .then(() => undefined)
    .catch((error) => console.error("[registroRecepcion] No se pudo registrar la clasificación ticket/factura (no crítico):", error instanceof Error ? error.message : error));
}

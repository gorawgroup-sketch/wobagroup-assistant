import type { TelegramCallbackQuery } from "../../telegram/types";
import type { ServicioConciliacionMultiple } from "./service";
import { estadoPlan } from "./model";

export interface DependenciasCallbackMultiple {
  servicio: Pick<ServicioConciliacionMultiple, "decidir">;
  puedeAprobar(userId: number): Promise<boolean>;
  responder(id: string, texto: string): Promise<unknown>;
  enviar(chatId: number, texto: string): Promise<unknown>;
}

export function crearHandlerConciliacionMultiple(deps: DependenciasCallbackMultiple) {
  return async (callback: TelegramCallbackQuery): Promise<void> => {
    const [accion, id, extra] = (callback.data ?? "").split(":");
    const chatId = callback.message?.chat.id;
    if (!["concilmulti_si", "concilmulti_no"].includes(accion) || !id || extra !== undefined || chatId === undefined) {
      await deps.responder(callback.id, "Confirmación inválida.").catch(() => {});
      return;
    }
    if (!await deps.puedeAprobar(callback.from.id)) {
      await deps.responder(callback.id, "Esta acción requiere al superadministrador.").catch(() => {});
      return;
    }
    await deps.responder(callback.id, "Revisando el plan...").catch(() => {});
    try {
      const p = await deps.servicio.decidir(id, chatId, callback.from.id, accion === "concilmulti_si");
      await deps.enviar(chatId, estadoPlan(p));
    } catch (error) {
      await deps.enviar(chatId, `No se pudo completar/verificar el plan ${id}: ${error instanceof Error ? error.message : String(error)}. ` +
        "Consulta el estado del plan antes de cualquier nueva operación. No se da por conciliado ni por resuelto.");
    }
    // No avanza genéricamente la cola: esta propuesta por IDs no es dueña de ese correo.
  };
}

export async function handleConciliacionMultipleCallback(callback: TelegramCallbackQuery): Promise<void> {
  const { answerCallbackQuery, sendTelegramMessage } = await import("../../telegram/client");
  const { obtenerRolUsuario, puedeAprobarAccionSensible } = await import("../../telegram/authorizedUsersSheet");
  const { conciliacionMultiple } = await import("./runtime");
  await crearHandlerConciliacionMultiple({
    servicio: conciliacionMultiple,
    puedeAprobar: async (id) => puedeAprobarAccionSensible(await obtenerRolUsuario(id)),
    responder: answerCallbackQuery, enviar: sendTelegramMessage,
  })(callback);
}

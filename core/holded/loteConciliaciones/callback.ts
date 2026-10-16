import type { TelegramCallbackQuery } from "../../telegram/types";
import type { ServicioLoteConciliaciones } from "./service";
import { estadoLote } from "./model";

export interface DependenciasCallbackLote {
  servicio: Pick<ServicioLoteConciliaciones, "decidir">;
  puedeAprobar(userId: number): Promise<boolean>;
  responder(id: string, texto: string): Promise<unknown>;
  enviar(chatId: number, texto: string): Promise<unknown>;
}

/** Botones del lote: «loteconcil_si» ejecuta todos los pares (uno a uno, verificados) y «loteconcil_no» los cancela. Solo superadministrador. */
export function crearHandlerLoteConciliaciones(deps: DependenciasCallbackLote) {
  return async (callback: TelegramCallbackQuery): Promise<void> => {
    const [accion, id, extra] = (callback.data ?? "").split(":");
    const chatId = callback.message?.chat.id;
    if (!["loteconcil_si", "loteconcil_no"].includes(accion) || !id || extra !== undefined || chatId === undefined) {
      await deps.responder(callback.id, "Confirmación inválida.").catch(() => {});
      return;
    }
    if (!await deps.puedeAprobar(callback.from.id)) {
      await deps.responder(callback.id, "Esta acción requiere al superadministrador.").catch(() => {});
      return;
    }
    await deps.responder(callback.id, accion === "loteconcil_si" ? "Revisando y conciliando…" : "Cancelando…").catch(() => {});
    try {
      const lote = await deps.servicio.decidir(id, chatId, callback.from.id, accion === "loteconcil_si");
      await deps.enviar(chatId, estadoLote(lote));
    } catch (error) {
      await deps.enviar(chatId, `No se pudo completar/verificar el lote ${id}: ${error instanceof Error ? error.message : String(error)}. ` +
        "Consulta el estado del lote antes de cualquier nueva operación. No se da por conciliado ni por resuelto.");
    }
  };
}

export async function handleLoteConciliacionesCallback(callback: TelegramCallbackQuery): Promise<void> {
  const { answerCallbackQuery, sendTelegramMessage } = await import("../../telegram/client");
  const { obtenerRolUsuario, puedeAprobarAccionSensible } = await import("../../telegram/authorizedUsersSheet");
  const { loteConciliaciones } = await import("./runtime");
  await crearHandlerLoteConciliaciones({
    servicio: loteConciliaciones,
    puedeAprobar: async (id) => puedeAprobarAccionSensible(await obtenerRolUsuario(id)),
    responder: answerCallbackQuery, enviar: sendTelegramMessage,
  })(callback);
}

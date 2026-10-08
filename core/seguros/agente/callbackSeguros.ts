/**
 * Botones «Aplicar» / «Cancelar» de una propuesta de Wobi Seguros (cambiosPendientes.ts). Solo `segcambio_aplicar`
 * escribe; `segcambio_cancelar` no toca nada, pero —como el resto de pares sí/no de este sistema— también lo decide un
 * superadministrador: ambos están en ACCIONES_SENSIBLES (authorizedUsersSheet.ts) y el despachador de server.ts ya
 * comprueba el rol ANTES de llegar aquí.
 */
import type { TelegramCallbackQuery } from "../../telegram/types";
import { entradaCambio } from "../bitacora/entradas";
import type { EntradaNueva } from "../bitacora/tipos";
import { almacenCambiosReal, aplicarCambio, type AlmacenCambios, type CambioPendiente, type ResultadoAplicar } from "./cambiosPendientes";

export interface DepsCallbackSeguros {
  almacen: Pick<AlmacenCambios, "ver" | "consumir">;
  aplicar(cambio: CambioPendiente, aprobadoPor: string): Promise<ResultadoAplicar>;
  responder(callbackId: string, texto?: string): Promise<void>;
  editar(chatId: number, messageId: number, texto: string): Promise<void>;
  retirarCaducada(callback: TelegramCallbackQuery, texto: string): Promise<void>;
  /** Deja constancia de la decisión en la bitácora de Seguros. Opcional y a prueba de fallos: nunca impide ni deshace la decisión. */
  registrar?(entrada: EntradaNueva): Promise<unknown>;
}

/** Las dependencias reales se cargan al usarse: este módulo lo importa server.ts y no debe arrastrar el cliente de Claude al arrancar. */
async function depsReales(): Promise<DepsCallbackSeguros> {
  const [{ answerCallbackQuery, editTelegramMessage }, { retirarPreguntaCaducada }, { depsAplicarReales }, { registrarActividad }] = await Promise.all([
    import("../../telegram/client"),
    import("../../telegram/preguntaCaducada"),
    import("./depsReales"),
    import("../bitacora/registrar"),
  ]);
  const aplicarDeps = depsAplicarReales();
  return {
    almacen: almacenCambiosReal,
    aplicar: (cambio, aprobadoPor) => aplicarCambio(cambio, aprobadoPor, aplicarDeps),
    responder: async (id, texto) => { await answerCallbackQuery(id, texto); },
    editar: (chatId, messageId, texto) => editTelegramMessage(chatId, messageId, texto, []),
    retirarCaducada: (callback, texto) => retirarPreguntaCaducada(callback, texto),
    registrar: (entrada) => registrarActividad(entrada),
  };
}

const nombreDe = (callback: TelegramCallbackQuery): string => {
  const u = callback.from as { first_name?: string; username?: string; id: number };
  return u.first_name || (u.username ? `@${u.username}` : String(u.id));
};

export async function handleSegurosCambioCallback(callback: TelegramCallbackQuery, deps?: DepsCallbackSeguros): Promise<void> {
  const d = deps ?? (await depsReales());
  const seguro = async (texto?: string) => { try { await d.responder(callback.id, texto); } catch (error) { console.error("[callbackSeguros] No se pudo responder el callback_query (no crítico):", error); } };
  const [accion, id] = (callback.data ?? "").split(":");
  // Solo estos dos botones existen; cualquier otra acción con este prefijo no se interpreta como «aplicar».
  if (!id || (accion !== "segcambio_aplicar" && accion !== "segcambio_cancelar")) { await seguro(); return; }

  // Se mira SIN retirar: un botón pulsado desde otro chat no debe destruir la propuesta del chat al que se envió.
  const pendiente = await d.almacen.ver(id);
  if (!pendiente) {
    await d.retirarCaducada(callback, "Esta propuesta ya no está disponible (expiró o ya se decidió).");
    return;
  }
  if (callback.message && callback.message.chat.id !== pendiente.chatId) {
    await seguro("Este botón no es de este chat.");
    return;
  }
  // Se decide una sola vez: quien llegue segundo (doble pulsación) ve que ya no está.
  const cambio = await d.almacen.consumir(id);
  if (!cambio) {
    await d.retirarCaducada(callback, "Esta propuesta ya no está disponible (expiró o ya se decidió).");
    return;
  }
  // Un fallo al editar el mensaje no puede dejar la decisión a medias: la propuesta ya está retirada.
  const editar = async (texto: string) => {
    try { await d.editar(cambio.chatId, cambio.messageId, texto); } catch (error) { console.error("[callbackSeguros] No se pudo editar el mensaje (no crítico):", error); }
  };
  // La constancia en la bitácora tampoco puede impedir la decisión.
  const registrar = async (entrada: EntradaNueva) => {
    try { await d.registrar?.(entrada); } catch (error) { console.error("[callbackSeguros] No se pudo anotar la decisión en la bitácora (no crítico):", error); }
  };
  const por = nombreDe(callback);

  if (accion === "segcambio_cancelar") {
    await seguro("Cancelado.");
    await editar("❌ Cancelado: no se cambió nada.");
    await registrar(entradaCambio({ cambio, decision: "cancelar", por }));
    return;
  }

  await seguro("Aplicando...");
  await editar("🔄 Aplicando el cambio…");
  try {
    const resultado = await d.aplicar(cambio, por);
    await editar(resultado.ok ? `✅ ${resultado.mensaje}` : `⚠️ ${resultado.mensaje}`);
    await registrar(entradaCambio({ cambio, decision: "aplicar", por, resultado }));
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    console.error("[callbackSeguros] Error aplicando el cambio:", mensaje);
    await editar(`⚠️ No pude confirmar el cambio: ${mensaje}\n\nComprueba el registro antes de repetirlo; la propuesta ya no está pendiente.`);
    await registrar(entradaCambio({ cambio, decision: "aplicar", por, error }));
  }
}

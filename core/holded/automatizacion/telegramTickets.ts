import { answerCallbackQuery, editTelegramMessage, sendTelegramMessageWithButtons } from "../../telegram/client";
import { obtenerAdmins } from "../../telegram/authorizedUsersSheet";
import type { TelegramCallbackQuery } from "../../telegram/types";
import type { Empresa } from "../client";
import { aprobarDudoso, rechazarDudoso, reanudarDisyuntor } from "./decisionesTickets";
import { etiquetaEmpresa } from "./empresas";
import { almacenTrabajosHolded } from "./trabajos";

/** Botones de autorización de la conversión a ticket (solo superadministrador: ver authorizedUsersSheet). */
const EMPRESAS: readonly Empresa[] = ["WOBA", "EWORKS", "Footprint"];

export interface DudosoParaPreguntar { empresa: Empresa; id: string; proveedor: string; total: string; moneda: string; fecha: string; motivos: string[] }

/** Pregunta a los administradores, con botones, si un gasto que la regla no puede decidir sola debe convertirse en ticket. */
export async function preguntarDudosoPorBoton(d: DudosoParaPreguntar): Promise<void> {
  const texto = `🧾 ¿Convertir a ticket?\n${etiquetaEmpresa(d.empresa)} · ${d.proveedor}\n${d.total} ${d.moneda} · ${d.fecha}\n\nLa regla no puede decidirlo sola (${d.motivos.join("; ")}). Si lo apruebas, se convierte solo cuando esté conciliado y con su comprobante.`;
  for (const admin of await obtenerAdmins()) {
    await sendTelegramMessageWithButtons(admin.userId, texto, [[
      { text: "✅ Convertir a ticket", callback_data: `tktregla_ok:${d.empresa}:${d.id}` },
      { text: "❌ No es ticket", callback_data: `tktregla_no:${d.empresa}:${d.id}` },
    ]]).catch((e) => console.error("[telegramTickets] No se pudo preguntar a un admin:", e instanceof Error ? e.message : e));
  }
}

/** Aviso del disyuntor con botón para reanudar tras revisar los casos. */
export async function avisarDisyuntorPorBoton(casos: number): Promise<void> {
  const texto = `🛑 Conversión a ticket DETENIDA por seguridad: ${casos} gasto(s) de las últimas 24 h terminaron con cambios inesperados en Holded.\n\nRevísalos en Holded (pídeme «estado de las automatizaciones de Holded» para verlos). Cuando estés conforme, pulsa reanudar.`;
  for (const admin of await obtenerAdmins()) {
    await sendTelegramMessageWithButtons(admin.userId, texto, [[{ text: "▶️ Reanudar conversión", callback_data: "tktdis_reanudar" }]])
      .catch((e) => console.error("[telegramTickets] No se pudo avisar del disyuntor:", e instanceof Error ? e.message : e));
  }
}

export async function handleTicketReglaCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data ?? "";
  const mensaje = callback.message;
  const editar = async (texto: string) => { if (mensaje) await editTelegramMessage(mensaje.chat.id, mensaje.message_id, texto, []).catch(() => undefined); };
  const almacen = almacenTrabajosHolded();
  if (data === "tktdis_reanudar") {
    const n = await reanudarDisyuntor(almacen);
    await answerCallbackQuery(callback.id, "Conversión reanudada.").catch(() => undefined);
    await editar(`▶️ Conversión reanudada (${n} caso(s) dados por revisados).`);
    return;
  }
  const [accion, empresa, id] = data.split(":");
  if ((accion !== "tktregla_ok" && accion !== "tktregla_no") || !EMPRESAS.includes(empresa as Empresa) || !/^[0-9a-f]{24}$/i.test(id ?? "")) {
    await answerCallbackQuery(callback.id, "Acción no reconocida.").catch(() => undefined);
    return;
  }
  const r = accion === "tktregla_ok" ? await aprobarDudoso(almacen, empresa as Empresa, id) : await rechazarDudoso(almacen, empresa as Empresa, id);
  const respuesta: Record<string, string> = {
    aprobado: "✅ Aprobado: se convierte a ticket en cuanto esté conciliado y con su comprobante.",
    rechazado: "❌ Hecho: no es un ticket, no se convierte.",
    ya_resuelto: "Esta decisión ya estaba tomada.",
    no_encontrado: "No encontré ese gasto en el registro.",
  };
  await answerCallbackQuery(callback.id, respuesta[r].slice(0, 190)).catch(() => undefined);
  await editar(`${respuesta[r]}\n(${etiquetaEmpresa(empresa)} · ${id.slice(0, 8)}…)`);
}

import { editTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";
import { consumirPropuesta, obtenerPropuesta, type Propuesta } from "../google/proposalSheet";
import { guardarPendienteExplicacion, type PendienteExplicacion } from "./pendienteExplicacionStore";
import { lineaDesdeExplicacion, palabrasClaveDesdeExplicacion, quitarReglaAgregada, registrarReglaAgregada, type ReglaAgregada } from "./reglasAgregadas";

/**
 * Botón «📝 Explicar: ya está incluido en otra línea» del aviso «Movimiento de Holded sin registrar en el cashflow».
 * Flujo: (1) el botón pide una frase y no toca la propuesta; (2) la respuesta se convierte en una regla (palabra clave del concepto +
 * línea del cashflow); (3) la propuesta se cierra como «no registrar» con la regla anotada y un botón para quitarla. Nunca escribe en el
 * cashflow, el banco ni Holded. Si de la frase no sale una palabra clave identificable, NO se crea nada y la propuesta queda intacta.
 */
export interface DependenciasExplicacion {
  obtenerPropuesta(id: string): Promise<Propuesta | undefined>;
  consumirPropuesta(id: string): Promise<Propuesta | undefined>;
  guardarPendiente(d: Omit<PendienteExplicacion, "creadoEn">): Promise<void>;
  registrarRegla(d: Omit<ReglaAgregada, "id" | "creadoEn">): Promise<ReglaAgregada>;
  quitarRegla(id: string): Promise<boolean>;
  enviarConBotones(chatId: number, texto: string, botones: Array<Array<{ text: string; callback_data: string }>>): Promise<number>;
  editar(chatId: number, messageId: number, texto: string, botones: Array<Array<{ text: string; callback_data: string }>>): Promise<unknown>;
}
const reales: DependenciasExplicacion = {
  obtenerPropuesta, consumirPropuesta, guardarPendiente: guardarPendienteExplicacion, registrarRegla: registrarReglaAgregada, quitarRegla: quitarReglaAgregada,
  enviarConBotones: sendTelegramMessageWithButtons, editar: editTelegramMessage,
};

export const EJEMPLO_EXPLICACION = "«Hace parte de la línea Nóminas, ya viene sumado con la de Heidi Antunes»";

/** Paso 1: el botón. Devuelve el aviso para el toast del callback. */
export async function iniciarExplicacion(propuestaId: string, chatId: number, d: DependenciasExplicacion = reales): Promise<string> {
  const p = await d.obtenerPropuesta(propuestaId);
  if (!p) return "Esta propuesta ya no está disponible.";
  if (p.chatId !== chatId) return "Esta propuesta pertenece a otro chat.";
  const promptId = await d.enviarConBotones(chatId,
    `📝 Cuéntame en una frase por qué «${p.clienteOConcepto}» (${p.valor.toFixed(2)} €, ${p.empresa}) ya está en el cashflow. ` +
    `Ejemplo: ${EJEMPLO_EXPLICACION}.\n\nResponde A ESTE MENSAJE (si respondes a otro, o pasan 15 minutos, no lo tomo como explicación). ` +
    `Incluye la palabra del concepto que identifica este tipo de movimiento (aquí, por ejemplo, «nómina»).`,
    [[{ text: "❌ Cancelar explicación", callback_data: `cf_explicar_no:${p.id}` }]]);
  await d.guardarPendiente({ chatId, propuestaId: p.id, promptMessageId: promptId });
  return "Responde al mensaje con tu explicación.";
}

/** Paso 2: la respuesta de texto. Devuelve el mensaje para el chat. */
export async function continuarConExplicacion(pend: PendienteExplicacion, texto: string, d: DependenciasExplicacion = reales): Promise<string> {
  const p = await d.obtenerPropuesta(pend.propuestaId);
  if (!p) return "Esa propuesta ya no está disponible (se resolvió o expiró); no aprendí nada.";
  const palabras = palabrasClaveDesdeExplicacion(p.clienteOConcepto, texto);
  if (palabras.length === 0) {
    return `No pude identificar qué palabra de «${p.clienteOConcepto}» define este tipo de movimiento. No aprendí nada y la propuesta sigue intacta. ` +
      `Pulsa «📝 Explicar» otra vez y menciona esa palabra, p. ej. ${EJEMPLO_EXPLICACION}.`;
  }
  const consumida = await d.consumirPropuesta(p.id);
  if (!consumida) return "Esa propuesta ya se procesó mientras tanto; no aprendí nada.";
  const regla = await d.registrarRegla({
    empresa: p.empresa, palabrasClave: palabras, lineaCashflow: lineaDesdeExplicacion(texto), explicacion: texto.trim(), tipo: p.bloqueSugerido === "ingresos" ? "ingreso" : "gasto",
  });
  await d.editar(p.chatId, p.messageId,
    `📝 Explicado — no se registra: ${p.clienteOConcepto} (${p.semana}, ${p.valor.toFixed(2)} €). El banco, Holded y el cashflow no se modificaron.\n\n` +
    `🧠 Aprendido: los ${regla.tipo === "ingreso" ? "abonos" : "cargos"} de ${regla.empresa} cuyo concepto contiene «${regla.palabrasClave.join(" + ")}» ya van sumados en «${regla.lineaCashflow}»; ` +
    `dejarán de salir como «sin registrar». Siempre se indicará cuántos movimientos cubre la regla.`,
    [[{ text: "↩️ Quitar esta regla", callback_data: `cf_regla_quitar:${regla.id}` }]]);
  return `✅ Anotado. Regla ${regla.id}: ${regla.empresa} · «${regla.palabrasClave.join(" + ")}» → «${regla.lineaCashflow}». Si no era eso, pulsa «↩️ Quitar esta regla» en el aviso original.`;
}

/** «↩️ Quitar esta regla» */
export async function quitarReglaPorBoton(reglaId: string, d: DependenciasExplicacion = reales): Promise<string> {
  return (await d.quitarRegla(reglaId)) ? "↩️ Regla eliminada: esos movimientos volverán a reportarse si no están en el cashflow." : "Esa regla ya no existe.";
}

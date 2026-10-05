import { sendTelegramMessageExpandable } from "../telegram/client";
import { guardarEstadoVigilante, purgarEstadoVigilante } from "../seguros/vigilante/estadoStore";
import { fuentesRealesVigilante } from "../seguros/vigilante/fuentesReales";
import type { Informe } from "../seguros/vigilante/informe";
import { ejecutarVigilanteSeguros, type FuentesVigilante } from "../seguros/vigilante/vigilante";

const MAX_CARACTERES_PENDIENTE = 40_000;

/**
 * Job del vigilante de Wobi Seguros (core/seguros/vigilante/): revisa el banco y el correo, mantiene al día el
 * registro de pólizas y avisa por Telegram SOLO de lo nuevo. A diario a las 8:35 y a las 17:35 (los avisos de
 * `revisarAlertasSeguros`, a las 8:50, ya ven el registro actualizado).
 *
 * La entrega es "al menos una vez": si Telegram falla, el informe queda guardado en la memoria del vigilante y se
 * reenvía en la siguiente revisión (lo detectado ya está marcado como avisado, así que no se duplica).
 */
export async function revisarSegurosVigilante(
  fuentes: FuentesVigilante = fuentesRealesVigilante(),
  enviar: (chatId: number, informe: Informe) => Promise<unknown> = (chatId, informe) =>
    sendTelegramMessageExpandable(chatId, informe.titulo, informe.cuerpo)
): Promise<{ avisado: boolean }> {
  const chatId = process.env.CASHFLOW_ALERTS_CHAT_ID ? Number(process.env.CASHFLOW_ALERTS_CHAT_ID) : undefined;
  if (!chatId) {
    console.error("[revisarSegurosVigilante] Falta CASHFLOW_ALERTS_CHAT_ID, no se puede notificar: no se revisa nada.");
    return { avisado: false };
  }

  const resultado = await ejecutarVigilanteSeguros(fuentes);
  let avisado = false;

  // 1) Un informe anterior que no llegó a entregarse va primero.
  let pendiente = resultado.pendienteEnvio;
  if (pendiente) {
    try {
      await enviar(chatId, pendiente);
      await purgarEstadoVigilante((e) => e.id === "pendiente_envio");
      pendiente = null;
      avisado = true;
    } catch (error) {
      console.error("[revisarSegurosVigilante] No se pudo reenviar el informe pendiente (se reintenta):", error);
    }
  }

  // 2) El informe de esta revisión.
  if (resultado.informe) {
    try {
      await enviar(chatId, resultado.informe);
      await guardarEstadoVigilante(resultado.clavesAvisadas);
      avisado = true;
    } catch (error) {
      console.error("[revisarSegurosVigilante] Error enviando el informe a Telegram (queda pendiente de reenvío):", error);
      const cuerpo = pendiente ? `${pendiente.cuerpo}\n\n---\n\n${resultado.informe.cuerpo}` : resultado.informe.cuerpo;
      const guardado: Informe = { titulo: resultado.informe.titulo, cuerpo: cuerpo.slice(-MAX_CARACTERES_PENDIENTE) };
      await guardarEstadoVigilante([...resultado.clavesAvisadas, { id: "pendiente_envio", version: JSON.stringify(guardado) }]).catch((e) =>
        console.error("[revisarSegurosVigilante] Tampoco se pudo guardar el informe pendiente:", e)
      );
    }
  } else if (resultado.clavesAvisadas.length > 0) {
    await guardarEstadoVigilante(resultado.clavesAvisadas).catch((e) => console.error("[revisarSegurosVigilante] Error marcando avisos (no crítico):", e));
  }

  console.log(
    `[revisarSegurosVigilante] ${resultado.hoy}: ${resultado.contenido.confirmados.length} pago(s) confirmado(s), ` +
      `${resultado.contenido.enTransito.length} en tránsito, ${resultado.contenido.devoluciones.length} devolución(es), ` +
      `${resultado.contenido.cargos.length} cargo(s) a revisar, ${resultado.contenido.correos.length} correo(s) nuevo(s); ` +
      `${avisado ? "aviso enviado" : "sin aviso"}.`
  );
  return { avisado };
}

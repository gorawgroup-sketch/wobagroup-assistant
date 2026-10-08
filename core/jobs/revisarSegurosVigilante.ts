import { sendTelegramMessageExpandable } from "../telegram/client";
import { invalidarComplementosSeguros } from "../seguros/estadoCerebro";
import { CLAVE_ULTIMA_REVISION, resumirRevision } from "../seguros/vigilante/ultimaRevision";
import { fuentesRealesVigilante } from "../seguros/vigilante/fuentesReales";
import type { Informe } from "../seguros/vigilante/informe";
import { ejecutarVigilanteSeguros, type FuentesVigilante, type ResultadoVigilante } from "../seguros/vigilante/vigilante";
import { entradaError, entradaVigilante } from "../seguros/bitacora/entradas";
import { registrarActividad, type Registrar } from "../seguros/bitacora/registrar";

const MAX_CARACTERES_PENDIENTE = 40_000;

/**
 * Job del vigilante de Wobi Seguros (core/seguros/vigilante/): revisa el banco y el correo, mantiene al día el
 * registro de pólizas y avisa por Telegram SOLO de lo nuevo. A diario a las 8:35 y a las 17:35 (los avisos de
 * `revisarAlertasSeguros`, a las 8:50, ya ven el registro actualizado).
 *
 * La entrega es "al menos una vez": si Telegram falla, el informe queda guardado en la memoria del vigilante y se
 * reenvía en la siguiente revisión (lo detectado ya está marcado como avisado, así que no se duplica).
 *
 * Cada pasada deja su constancia en la bitácora (core/seguros/bitacora/), también la que no encuentra nada: así Cerebro enseña
 * qué hizo el vigilante y cuándo. `extras` permite sustituir el registrador y el vigilante en las pruebas.
 */
export async function revisarSegurosVigilante(
  fuentes: FuentesVigilante = fuentesRealesVigilante(),
  enviar: (chatId: number, informe: Informe) => Promise<unknown> = (chatId, informe) =>
    sendTelegramMessageExpandable(chatId, informe.titulo, informe.cuerpo),
  extras: { registrar?: Registrar; ejecutar?: (fuentes: FuentesVigilante) => Promise<ResultadoVigilante> } = {}
): Promise<{ avisado: boolean }> {
  const registrar = extras.registrar ?? registrarActividad;
  const ejecutar = extras.ejecutar ?? ejecutarVigilanteSeguros;
  const chatId = process.env.CASHFLOW_ALERTS_CHAT_ID ? Number(process.env.CASHFLOW_ALERTS_CHAT_ID) : undefined;
  if (!chatId) {
    console.error("[revisarSegurosVigilante] Falta CASHFLOW_ALERTS_CHAT_ID, no se puede notificar: no se revisa nada.");
    await registrar(entradaError("vigilante", "programada", new Error("Falta CASHFLOW_ALERTS_CHAT_ID"), "No se pudo revisar"));
    return { avisado: false };
  }

  let resultado: ResultadoVigilante;
  try {
    resultado = await ejecutar(fuentes);
  } catch (error) {
    await registrar(entradaError("vigilante", "programada", error, "La revisión falló"));
    throw error;
  }
  let avisado = false;
  // Constancia para la bitácora: null = no había informe que enviar; true/false = Telegram lo aceptó o no.
  let entregado: boolean | null = null;
  let reenviado = false;

  // Resumen para el panel de Cerebro («última revisión…»): se guarda siempre, haya o no aviso.
  await fuentes.guardarEstado([{ id: CLAVE_ULTIMA_REVISION, version: JSON.stringify(resumirRevision(resultado, fuentes.ahora())) }])
    .then(() => invalidarComplementosSeguros())
    .catch((error) => console.error("[revisarSegurosVigilante] No se pudo guardar el resumen de la revisión (no crítico):", error));

  // 1) Un informe anterior que no llegó a entregarse va primero.
  let pendiente = resultado.pendienteEnvio;
  if (pendiente) {
    try {
      await enviar(chatId, pendiente);
      await fuentes.borrarEstado(["pendiente_envio"]);
      pendiente = null;
      avisado = true;
      reenviado = true;
    } catch (error) {
      console.error("[revisarSegurosVigilante] No se pudo reenviar el informe pendiente (se reintenta):", error);
    }
  }

  // 2) El informe de esta revisión.
  if (resultado.informe) {
    try {
      await enviar(chatId, resultado.informe);
      entregado = true;
      await fuentes.guardarEstado(resultado.clavesAvisadas);
      avisado = true;
    } catch (error) {
      if (entregado !== true) entregado = false;
      console.error("[revisarSegurosVigilante] Error enviando el informe a Telegram (queda pendiente de reenvío):", error);
      const cuerpo = pendiente ? `${pendiente.cuerpo}\n\n---\n\n${resultado.informe.cuerpo}` : resultado.informe.cuerpo;
      const guardado: Informe = { titulo: resultado.informe.titulo, cuerpo: cuerpo.slice(-MAX_CARACTERES_PENDIENTE) };
      await fuentes.guardarEstado([...resultado.clavesAvisadas, { id: "pendiente_envio", version: JSON.stringify(guardado) }]).catch((e) =>
        console.error("[revisarSegurosVigilante] Tampoco se pudo guardar el informe pendiente:", e)
      );
    }
  } else if (resultado.clavesAvisadas.length > 0) {
    await fuentes.guardarEstado(resultado.clavesAvisadas).catch((e) => console.error("[revisarSegurosVigilante] Error marcando avisos (no crítico):", e));
  }

  await registrar(entradaVigilante({ resultado, informe: resultado.informe, entregado, reenviado }));
  console.log(
    `[revisarSegurosVigilante] ${resultado.hoy}: ${resultado.contenido.confirmados.length} pago(s) confirmado(s), ` +
      `${resultado.contenido.enTransito.length} en tránsito, ${resultado.contenido.devoluciones.length} devolución(es), ` +
      `${resultado.contenido.cargos.length} cargo(s) a revisar, ${resultado.contenido.correos.length} correo(s) nuevo(s); ` +
      `${avisado ? "aviso enviado" : "sin aviso"}.`
  );
  return { avisado };
}

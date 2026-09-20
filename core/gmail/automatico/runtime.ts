import { buscarCuentaCorregidaAprendida } from "../../holded/cuentaCorregidaAprendidaSheet";
import { registrarAsignacionCuenta } from "../../holded/asignacionCuentaLogSheet";
import { getGmailClient, getGmailModifyClient } from "../client";
import { obtenerActivoActual } from "../colaRevisionStore";
import { obtenerEstadoHiloAutorespuesta } from "../hiloAutorespuestaStore";
import { obtenerTodosLosAlias } from "../../gastos/proveedorAliasSheet";
import { buscarGastoDesdeCorreo, registrarGastoDesdeCorreo } from "../../gastos/gastoPorCorreoStore";
import { revalidarRegistroRecienteDeCorreo } from "../../gastos/verificarGastoPorCorreo";
import { buscarPropuestaGastoPendiente, obtenerPropuestasGastoPorChat } from "../../gastos/gastoProposalSheet";
import { obtenerPropuestasAccionCorreoPorChat } from "../emailActionStore";
import { GmailAuto } from "./gmail";
import { analizarAutomatico } from "./analyze";
import { HoldedAuto } from "./holded";
import { configuracionAuto, normalizar, type ResultadoAuto } from "./model";
import { PostgresAutoStore, conOperacionAuto, protegerEscrituraHolded, hayCoordinacionDurable, poolAuto } from "./postgres";
import { ServicioCorreoAutomatico } from "./service";
import { editTelegramMessage, sendTelegramMessageSmart } from "../../telegram/client";
import { enteroAcotado } from "../../utils/asyncTimeout";

export async function revisarGastosAutomaticos(chatId: number, opciones: {
  informarProgreso?: boolean | (() => boolean);
} = {}): Promise<ResultadoAuto> {
  const config = configuracionAuto();
  if (config.modo === "off") return { modo: "off", revisados: 0, completados: 0, simulados: 0, pendientes: [], gastos: [] };
  const fechaLimite = Date.now() + enteroAcotado(process.env.WOBI_MAIL_AUTO_MAX_RUN_MS, 8 * 60_000, 2 * 60_000, 30 * 60_000);
  let mensajeProgreso: number | undefined;
  let colaNotificacion = Promise.resolve();
  const notificar = (texto: string): Promise<void> => {
    console.log(`[correo-auto] ${texto}`);
    const informar = typeof opciones.informarProgreso === "function" ? opciones.informarProgreso() : opciones.informarProgreso;
    if (!informar) return Promise.resolve();
    colaNotificacion = colaNotificacion.then(async () => {
      if (mensajeProgreso === undefined) mensajeProgreso = await sendTelegramMessageSmart(chatId, texto);
      else await editTelegramMessage(chatId, mensajeProgreso, texto, []);
    }).catch(error => console.error("[correo-auto] No se pudo actualizar el progreso en Telegram:", error));
    return colaNotificacion;
  };
  const esHito = (completados: number, total: number): boolean => completados === 0 || completados === total ||
    (total > 0 && completados % Math.max(1, Math.ceil(total / 4)) === 0);
  const gmail = new GmailAuto(getGmailClient(), getGmailModifyClient(), { concurrencia: 4, progreso: async (completados, total) => {
    if (esHito(completados, total)) await notificar(completados === 0
      ? `⏳ Revisión automática iniciada: ${total} hilo(s) sin leer. Descargando contenido y adjuntos…`
      : `⏳ Correo descargado: ${completados}/${total}.`);
  } });
  let aliasPromise: ReturnType<typeof obtenerTodosLosAlias> | undefined;
  const holded = new HoldedAuto({
    cuentaConfirmada: (empresa, proveedor) => buscarCuentaCorregidaAprendida(proveedor, empresa),
    alias: async (empresa, proveedor) => (await (aliasPromise ??= obtenerTodosLosAlias()))
      .filter(a => a.empresa === empresa && normalizar(a.nombreDetectado) === normalizar(proveedor)),
    duplicadoInterno: async (c, r) => {
      const registro = await buscarGastoDesdeCorreo(c.id, r.fuente === "cuerpo" ? undefined : r.fuente);
      if (registro) {
        const estado = await revalidarRegistroRecienteDeCorreo(registro);
        if (estado !== "fantasma_eliminado") return true;
        // El 404 reciente demostró que esa referencia era fantasma. El
        // analizador automático puede continuar con los bytes reales de
        // este recibo; las barreras estrictas de Holded se aplican después.
      }
      if (r.empresa === "desconocida") return true;
      return Boolean(await buscarPropuestaGastoPendiente(r.empresa, r.proveedor, r.equivalente?.monto ?? r.monto));
    },
  }, fetch, config.empresas);
  const chats = [...new Set([chatId, Number(process.env.CASHFLOW_ALERTS_CHAT_ID)].filter(Number.isFinite))];
  const manuales = new Set<string>();
  for (const chat of chats) {
    const activo = await obtenerActivoActual(chat);
    if (activo) manuales.add(activo.id);
    for (const p of await obtenerPropuestasGastoPorChat(chat)) if (p.correoOrigen?.threadId) manuales.add(p.correoOrigen.threadId);
    for (const p of await obtenerPropuestasAccionCorreoPorChat(chat)) manuales.add(p.threadId);
  }
  const service = new ServicioCorreoAutomatico(new PostgresAutoStore(), {
    listar: () => gmail.listar(), analizar: analizarAutomatico,
    reservadoManualmente: async id => {
      if (manuales.has(id)) return true;
      const estado = await obtenerEstadoHiloAutorespuesta(id);
      return estado?.estado === "aprobado" || estado?.estado === "pendiente";
    },
    evidencias: (c, r) => holded.evidencias(c, r),
    recuperarCreacion: op => holded.recuperarCreacion(op),
    registrarFinalizada: async op => {
      const attachmentId = op.plan.recibo.fuente === "cuerpo" ? undefined : op.plan.recibo.fuente;
      if (!await buscarGastoDesdeCorreo(op.plan.correo.id, attachmentId)) {
        if (op.plan.cuentaId) {
          await registrarAsignacionCuenta({ gastoId: op.compraId!, empresa: op.plan.empresa,
            proveedor: op.plan.recibo.proveedor, cuentaIdAsignada: op.plan.cuentaId });
        }
        await registrarGastoDesdeCorreo({ mensajeIdGmail: op.plan.correo.id, attachmentId,
          gastoId: op.compraId!, empresa: op.plan.empresa });
      }
    },
    crear: op => holded.crear(op), verificarCreacion: op => holded.verificarCreacion(op),
    adjuntar: (op, c) => holded.adjuntar(op, c), verificarAdjunto: op => holded.verificarAdjunto(op),
    conciliar: op => holded.conciliar(op), verificarConciliacion: op => holded.verificarConciliacion(op),
    marcarResuelto: c => gmail.marcarResuelto(c),
    permitidoAhora: op => {
      const actual = configuracionAuto();
      return actual.modo === "execute" && actual.empresas.includes(op.plan.empresa);
    },
    ejecutarProtegido: (op, tarea) => conOperacionAuto(op.id, () => protegerEscrituraHolded(op.plan.empresa, tarea)),
  }, { concurrenciaAnalisis: 2, fechaLimite, progreso: async ({ fase, completados, total }) => {
    if (!esHito(completados, total)) return;
    await notificar(fase === "analisis"
      ? (completados === 0 ? `⏳ Analizando ${total} mensaje(s), hasta 2 a la vez…` : `⏳ Mensajes analizados: ${completados}/${total}.`)
      : (completados === 0 ? `⏳ Verificando candidatos en Gmail y Holded…` : `⏳ Candidatos verificados: ${completados}/${total}.`));
  } });
  const resultado = await service.revisar(config);
  await colaNotificacion;
  return resultado;
}

/** Una propuesta antigua no puede reabrir un correo con una escritura incompleta. */
export async function comprobarCorreoDisponible(threadId: string): Promise<void> {
  if (!hayCoordinacionDurable()) return;
  const r = await poolAuto().query("SELECT id FROM wobi_mail_operations WHERE mailbox=$1 AND data->'plan'->'correo'->>'threadId'=$2 AND state NOT IN ('completada','rechazada') LIMIT 1",
    [process.env.GMAIL_IMPERSONATE_EMAIL ?? "", threadId]);
  if (r.rowCount) throw new Error(`Este correo tiene la operación ${r.rows[0].id} pendiente de verificar. No se repetirán escrituras.`);
}

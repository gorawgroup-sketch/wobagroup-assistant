import type { Empresa } from "../client";
import { answerCallbackQuery, editTelegramMessage, sendTelegramMessage, sendTelegramMessageWithButtons } from "../../telegram/client";
import type { TelegramCallbackQuery } from "../../telegram/types";
import { conMutex } from "../../utils/asyncMutex";
import { etiquetaEmpresa } from "../automatizacion/empresas";
import type { PropuestaTransferencia } from "./deteccion";
import { ejecutarTransferencia } from "./ejecucion";
import { describirPropuesta } from "./informe";
import { detectarTransferenciasDeEmpresa } from "./lectura";
import { ejecucionAutorizada, modoTransferencias } from "./modo";
import { guardarRegistro, listarRegistros, obtenerRegistroPorId, registroDesdePropuesta, type RegistroTransferencia } from "./registro";

/** Propuestas de transferencias internas en Telegram y sus cuatro botones. Solo «Conciliar» puede llegar a escribir en Holded. */

const MAX_PROPUESTAS_POR_PASADA = 5;
const DIAS_ATRAS = 45;
/** Estados en los que la operación ya tiene una propuesta viva, una decisión o un resultado: no se vuelve a proponer. */
const CERRADOS: ReadonlyArray<RegistroTransferencia["estado"]> = ["propuesta", "ambigua", "aprobada", "ejecutando", "verificada", "fallida", "descartada", "revision_manual"];

/**
 * Cada botón de Telegram solo se atiende UNA vez por mensaje (la entrega durable deduplica las acciones sensibles),
 * así que todo lo que deba poder pulsarse de nuevo se publica en un mensaje nuevo.
 */
export function botonesPropuesta(id: string, opciones: { conConciliar?: boolean; soloVerificar?: boolean } = {}) {
  if (opciones.soloVerificar) return [[{ text: "🔎 Comprobar en Holded y continuar", callback_data: `transfint_conciliar:${id}` }]];
  return [
    ...(opciones.conConciliar === false ? [] : [[{ text: "✅ Conciliar transferencia", callback_data: `transfint_conciliar:${id}` }]]),
    [{ text: "⏭️ Saltar por ahora", callback_data: `transfint_saltar:${id}` }, { text: "🚫 No es una transferencia", callback_data: `transfint_noes:${id}` }],
    [{ text: "🔎 Revisar manualmente", callback_data: `transfint_manual:${id}` }],
  ];
}

export function textoPropuesta(p: PropuestaTransferencia): string {
  return `🔁 Operación entre cuentas propias — ${etiquetaEmpresa(p.empresa)}\n${describirPropuesta(p)}\n\n` +
    (p.confianza === "bloqueada"
      ? "Está bloqueada: no se puede conciliar desde aquí; decide qué hacer con ella."
      : p.tipo === "conversion"
        ? "Es una conversión de moneda: solo se ejecuta desde aquí si esta pareja está autorizada por escrito; si no, solo se propone."
        : "Al conciliar se hace en Holded la transferencia entre las dos cuentas (un único asiento: debe la de destino, haber la de origen) y quedan conciliados los dos movimientos. No se crea ingreso ni gasto.") +
    `\nReferencia para autorizarla: ${p.clave}`;
}

/** Detecta y publica las operaciones que aún no tienen propuesta. Devuelve el resumen para el chat. Solo lee Holded. */
export async function publicarPropuestasTransferencias(chatId: number, empresas: readonly Empresa[]): Promise<string> {
  if (modoTransferencias() === "apagado") return "La conciliación de transferencias internas está apagada (WOBI_TRANSFERENCIAS_MODO).";
  const hoy = new Date().toISOString().slice(0, 10);
  const desde = new Date(Date.now() - DIAS_ATRAS * 86_400_000).toISOString().slice(0, 10);
  const resumen: string[] = [];
  let publicadas = 0, restantes = 0;

  // Operaciones que un corte dejó a medias: no tienen ningún botón vivo, así que se ofrece verificarlas.
  for (const r of (await listarRegistros()).filter((x) => empresas.includes(x.empresa) && (x.estado === "aprobada" || x.estado === "ejecutando"))) {
    const messageId = await sendTelegramMessageWithButtons(chatId,
      `⚠️ Operación a medias — ${resumenRegistro(r)}\nUn intento anterior no terminó de registrarse. Al pulsar se comprueba por lectura cómo quedó en Holded.`,
      botonesPropuesta(r.id, { soloVerificar: true }));
    await guardarRegistro({ ...r, chatId, messageId });
  }

  for (const empresa of empresas) {
    const lectura = await detectarTransferenciasDeEmpresa(empresa, desde, hoy, hoy);
    let sinDecidir = 0;
    for (const p of lectura.propuestas) {
      // El registro se relee justo antes de escribir: una pasada no puede pisar una operación que otra acaba de tocar.
      const actual = (await listarRegistros()).find((r) => r.clave === p.clave);
      if (actual && CERRADOS.includes(actual.estado)) continue;
      sinDecidir++;
      if (publicadas >= MAX_PROPUESTAS_POR_PASADA) { restantes++; continue; }
      const registro = registroDesdePropuesta(p);
      const bloqueada = p.confianza === "bloqueada";
      await guardarRegistro(registro);
      // Las conversiones de moneda solo llevan botón de conciliar si esa pareja está autorizada por escrito.
      const messageId = await sendTelegramMessageWithButtons(chatId, textoPropuesta(p), botonesPropuesta(registro.id, { conConciliar: !bloqueada && (p.tipo !== "conversion" || ejecucionAutorizada(p.clave, process.env, "conversion")) }));
      await guardarRegistro({ ...registro, estado: bloqueada ? "ambigua" : "propuesta", chatId, messageId });
      publicadas++;
    }
    resumen.push(`${empresa}: ${lectura.propuestas.length} detectada(s), ${sinDecidir} sin decidir`);
  }
  return `Transferencias internas — ${resumen.join("; ")}. Publiqué ${publicadas} propuesta(s) con botones` +
    (restantes > 0 ? `; quedan ${restantes} más, que publicaré cuando decidas estas (vuelve a pedírmelo).` : ".") +
    (modoTransferencias() === "observacion" ? " Modo observación: «Conciliar» todavía no ejecuta nada en Holded." : "");
}

async function responder(callback: TelegramCallbackQuery, texto?: string): Promise<void> {
  try {
    await answerCallbackQuery(callback.id, texto);
  } catch (error) {
    console.error("[transferencias] No se pudo responder el callback_query (no crítico):", error instanceof Error ? error.message : error);
  }
}

const resumenRegistro = (r: RegistroTransferencia) =>
  `${r.empresa} · ${r.fecha} · ${Math.abs(r.importeOrigen).toFixed(2)} ${r.monedaOrigen} → ${r.importeDestino.toFixed(2)} ${r.monedaDestino}`;

export async function handleTransferenciasCallback(callback: TelegramCallbackQuery): Promise<void> {
  const [accion, id] = (callback.data ?? "").split(":");
  const chatId = callback.message?.chat.id;
  const registro = id ? await obtenerRegistroPorId(id) : undefined;
  if (!chatId || !registro) { await responder(callback, "Esta propuesta ya no está disponible."); return; }
  const mensajeId = callback.message?.message_id ?? registro.messageId;
  const cerrarMensaje = (texto: string) =>
    editTelegramMessage(chatId, mensajeId, texto, []).catch((error) =>
      console.error("[transferencias] No se pudo actualizar el mensaje de la propuesta:", error instanceof Error ? error.message : error));
  /** Mensaje NUEVO con botones: el del mensaje anterior ya no vuelve a atenderse. */
  const republicar = async (r: RegistroTransferencia, texto: string, opciones: Parameters<typeof botonesPropuesta>[1]) => {
    const nuevoId = await sendTelegramMessageWithButtons(chatId, texto, botonesPropuesta(r.id, opciones));
    await guardarRegistro({ ...r, chatId, messageId: nuevoId });
  };

  if (accion === "transfint_saltar" || accion === "transfint_noes" || accion === "transfint_manual") {
    if (registro.estado !== "propuesta" && registro.estado !== "ambigua") { await responder(callback, `Ya está ${registro.estado}.`); return; }
    const [estado, detalle, texto] = accion === "transfint_saltar"
      ? ["saltada" as const, "Saltada por ahora; se volverá a proponer.", `⏭️ Saltada por ahora — ${resumenRegistro(registro)}. Sigue pendiente y volverá a proponerse.`]
      : accion === "transfint_noes"
        ? ["descartada" as const, "El operador indicó que no es una transferencia.", `🚫 No es una transferencia — ${resumenRegistro(registro)}. No se volverá a proponer esta pareja.`]
        : ["revision_manual" as const, "El operador la revisará a mano en Holded.", `🔎 Revisión manual — ${resumenRegistro(registro)}. Queda a tu cargo en Holded; Wobi no la tocará.`];
    await guardarRegistro({ ...registro, estado, detalle });
    await responder(callback, "Anotado.");
    await cerrarMensaje(texto);
    return;
  }
  if (accion !== "transfint_conciliar") { await responder(callback); return; }

  if (!["propuesta", "aprobada", "ejecutando", "fallida"].includes(registro.estado)) { await responder(callback, `Ya está ${registro.estado}.`); return; }
  // Verificar un intento anterior es solo lectura; ejecutar exige el modo activo y la autorización escrita de la pareja.
  const soloVerificacion = registro.estado === "ejecutando" || registro.estado === "fallida";
  if (!soloVerificacion && !ejecucionAutorizada(registro.clave, process.env, registro.tipo)) {
    await responder(callback, "Ejecución no autorizada todavía.");
    await cerrarMensaje(`⛔ ${resumenRegistro(registro)}\nNo escribí nada en Holded: esta transferencia todavía no está autorizada.`);
    await republicar(registro, `🔁 ${resumenRegistro(registro)}\nSigue pendiente. Solo se ejecutan las parejas autorizadas por escrito.\nReferencia para autorizarla: ${registro.clave}`, {});
    return;
  }
  await responder(callback, soloVerificacion ? "Verificando..." : "En cola para conciliar...");
  await cerrarMensaje(`🔄 ${soloVerificacion ? "Verificando" : "Conciliando la transferencia"} — ${resumenRegistro(registro)}...\nTarda 1–3 minutos (más si hay otras en cola). Puedes seguir usando Wobi mientras tanto; te aviso aquí al terminar.`);
  // Carril propio: la ejecución sigue en segundo plano y el chat queda libre para correos, gastos y otras conciliaciones.
  // Las transferencias se atienden de una en una, en el orden en que se pulsaron; el estado se relee dentro.
  void ejecutarEnSuCarril(registro, cerrarMensaje, republicar).catch((e) =>
    console.error("[transferencias] Fallo inesperado en el carril de ejecución:", e instanceof Error ? e.message : e));
}

async function ejecutarEnSuCarril(
  registro: RegistroTransferencia,
  cerrarMensaje: (texto: string) => Promise<unknown>,
  republicar: (r: RegistroTransferencia, texto: string, opciones: Parameters<typeof botonesPropuesta>[1]) => Promise<void>
): Promise<void> {
  try {
    const resultado = await conMutex("transferencias:ejecucion", async () => {
      const actual = (await obtenerRegistroPorId(registro.id)) ?? registro;
      // Escribir exige el modo activo y la autorización escrita de la pareja; sin ella el ejecutor solo lee e informa.
      const opciones = { permitirEscritura: ejecucionAutorizada(actual.clave, process.env, actual.tipo) };
      if (actual.estado !== "propuesta") return ejecutarTransferencia(actual, undefined, opciones);
      const aprobada: RegistroTransferencia = { ...actual, estado: "aprobada", detalle: "Aprobada por el operador." };
      await guardarRegistro(aprobada);
      return ejecutarTransferencia(aprobada, undefined, opciones);
    });
    const icono = resultado.estado === "verificada" ? "✅" : resultado.estado === "fallida" ? "🛑" : "⚠️";
    await cerrarMensaje(`${icono} ${resumenRegistro(registro)}\n${resultado.mensaje}`);
    if (resultado.estado === "propuesta") await republicar(resultado.registro, `🔁 ${resumenRegistro(registro)}\nSigue pendiente; puedes volver a intentarlo.`, {});
    if (resultado.estado === "fallida") await republicar(resultado.registro, `🛑 ${resumenRegistro(registro)}\nCuando lo hayas revisado en Holded, pulsa: leo cómo quedó y, si la pareja está autorizada y no hay nada a medias, la termino.`, { soloVerificar: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[transferencias] Error ejecutando la transferencia:", message);
    await cerrarMensaje(`🛑 ${resumenRegistro(registro)}\nLa ejecución se interrumpió (${message.slice(0, 250)}). No se reintenta sola.`);
    const actual = (await obtenerRegistroPorId(registro.id).catch(() => undefined)) ?? registro;
    await republicar(actual, `⚠️ ${resumenRegistro(registro)}\nPulsa para comprobar por lectura cómo quedó en Holded.`, { soloVerificar: true }).catch((e) =>
      console.error("[transferencias] No se pudo publicar el botón de verificación:", e instanceof Error ? e.message : e));
  }
}

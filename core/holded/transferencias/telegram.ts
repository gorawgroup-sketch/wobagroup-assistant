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
/** Estados en los que la operación ya tiene una decisión o un resultado: no se vuelve a proponer. */
const CERRADOS: ReadonlyArray<RegistroTransferencia["estado"]> = ["propuesta", "aprobada", "ejecutando", "verificada", "fallida", "descartada", "revision_manual"];

export function botonesPropuesta(id: string) {
  return [
    [{ text: "✅ Conciliar transferencia", callback_data: `transfint_conciliar:${id}` }],
    [{ text: "⏭️ Saltar por ahora", callback_data: `transfint_saltar:${id}` }, { text: "🚫 No es una transferencia", callback_data: `transfint_noes:${id}` }],
    [{ text: "🔎 Revisar manualmente", callback_data: `transfint_manual:${id}` }],
  ];
}

export function textoPropuesta(p: PropuestaTransferencia): string {
  return `🔁 Operación entre cuentas propias — ${etiquetaEmpresa(p.empresa)}\n${describirPropuesta(p)}\n\n` +
    (p.tipo === "conversion"
      ? "Es una conversión de moneda: por ahora solo se propone; todavía no se ejecuta desde aquí."
      : "Al conciliar se crea un único asiento (debe la cuenta de destino, haber la de origen) y se concilian los dos movimientos. No se crea ingreso ni gasto.");
}

/** Detecta y publica las operaciones que aún no tienen propuesta. Devuelve el resumen para el chat. Solo lee Holded. */
export async function publicarPropuestasTransferencias(chatId: number, empresas: readonly Empresa[]): Promise<string> {
  if (modoTransferencias() === "apagado") return "La conciliación de transferencias internas está apagada (WOBI_TRANSFERENCIAS_MODO).";
  const hoy = new Date().toISOString().slice(0, 10);
  const desde = new Date(Date.now() - DIAS_ATRAS * 86_400_000).toISOString().slice(0, 10);
  const registros = new Map((await listarRegistros()).map((r) => [r.clave, r]));
  const resumen: string[] = [];
  let publicadas = 0, restantes = 0;
  for (const empresa of empresas) {
    const lectura = await detectarTransferenciasDeEmpresa(empresa, desde, hoy, hoy);
    const nuevas = lectura.propuestas.filter((p) => !CERRADOS.includes(registros.get(p.clave)?.estado ?? "detectada"));
    resumen.push(`${empresa}: ${lectura.propuestas.length} detectada(s), ${nuevas.length} sin decidir`);
    for (const p of nuevas) {
      if (publicadas >= MAX_PROPUESTAS_POR_PASADA) { restantes++; continue; }
      const registro = registroDesdePropuesta(p);
      await guardarRegistro(registro);
      const messageId = await sendTelegramMessageWithButtons(chatId, textoPropuesta(p), botonesPropuesta(registro.id));
      await guardarRegistro({ ...registro, estado: "propuesta", chatId, messageId });
      publicadas++;
    }
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
  const cerrarMensaje = (texto: string, conBotones = false) =>
    editTelegramMessage(chatId, mensajeId, texto, conBotones ? botonesPropuesta(registro.id) : []).catch((error) =>
      console.error("[transferencias] No se pudo actualizar el mensaje de la propuesta:", error instanceof Error ? error.message : error));

  if (registro.estado !== "propuesta" && accion !== "transfint_conciliar") {
    await responder(callback, `Ya está ${registro.estado}.`);
    return;
  }
  if (accion === "transfint_saltar") {
    await guardarRegistro({ ...registro, estado: "saltada", detalle: "Saltada por ahora; se volverá a proponer." });
    await responder(callback, "Saltada.");
    await cerrarMensaje(`⏭️ Saltada por ahora — ${resumenRegistro(registro)}. Sigue pendiente y volverá a proponerse.`);
    return;
  }
  if (accion === "transfint_noes") {
    await guardarRegistro({ ...registro, estado: "descartada", detalle: "El operador indicó que no es una transferencia." });
    await responder(callback, "Anotado.");
    await cerrarMensaje(`🚫 No es una transferencia — ${resumenRegistro(registro)}. No se volverá a proponer esta pareja.`);
    return;
  }
  if (accion === "transfint_manual") {
    await guardarRegistro({ ...registro, estado: "revision_manual", detalle: "El operador la revisará a mano en Holded." });
    await responder(callback, "Anotado.");
    await cerrarMensaje(`🔎 Revisión manual — ${resumenRegistro(registro)}. Queda a tu cargo en Holded; Wobi no la tocará.`);
    return;
  }
  if (accion !== "transfint_conciliar") { await responder(callback); return; }

  if (!["propuesta", "ejecutando", "fallida"].includes(registro.estado)) { await responder(callback, `Ya está ${registro.estado}.`); return; }
  if (!ejecucionAutorizada(registro.clave)) {
    await responder(callback, "Ejecución no autorizada todavía.");
    await sendTelegramMessage(chatId, `⛔ No escribí nada en Holded: la ejecución de esta transferencia (${resumenRegistro(registro)}) todavía no está autorizada. ` +
      `Solo se ejecutan las parejas aprobadas por escrito.`);
    return;
  }
  await responder(callback, "Conciliando...");
  await cerrarMensaje(`🔄 Conciliando la transferencia — ${resumenRegistro(registro)}...`);
  try {
    // Un doble toque no puede lanzar dos ejecuciones: se serializa por pareja y el estado se relee dentro.
    const resultado = await conMutex(`transferencia:${registro.clave}`, async () => {
      const actual = (await obtenerRegistroPorId(registro.id)) ?? registro;
      if (actual.estado !== "propuesta") return ejecutarTransferencia(actual);
      const aprobada: RegistroTransferencia = { ...actual, estado: "aprobada", detalle: "Aprobada por el operador." };
      await guardarRegistro(aprobada);
      return ejecutarTransferencia(aprobada);
    });
    const icono = resultado.estado === "verificada" ? "✅" : resultado.estado === "revision_manual" ? "⚠️" : "🛑";
    await cerrarMensaje(`${icono} ${resumenRegistro(registro)}\n${resultado.mensaje}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[transferencias] Error ejecutando la transferencia:", message);
    await cerrarMensaje(`🛑 ${resumenRegistro(registro)}\nLa ejecución se interrumpió (${message.slice(0, 250)}). No se reintenta sola: pulsa de nuevo «Conciliar» y verificaré por lectura cómo quedó.`, true);
  }
}

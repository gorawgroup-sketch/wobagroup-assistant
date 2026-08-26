import { answerCallbackQuery, editTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";
import { obtenerEntradaPorId, calcularProximaFecha } from "./calendario";
import { formatDateLocal } from "../utils/dateFormat";
import { weekLabel } from "../utils/isoWeek";
import { guardarPendienteMontoPago, type PendienteMontoPago } from "./pendienteMontoStore";
import {
  crearPropuestaPagoRecurrente,
  actualizarMessageIdPagoRecurrente,
  consumirPropuestaPagoRecurrente,
  type PropuestaPagoRecurrente,
} from "./pagoRecurrenteProposalSheet";
import { buscarContactoHolded, crearGastoHolded } from "../holded/write";
import { registrarMovimientoEnSheet } from "../google/cashflowWrite";
import type { TelegramCallbackQuery } from "../telegram/types";

/**
 * Etiqueta de periodicidad que se antepone al concepto tanto en Holded como
 * en el cashflow, para que quede trazable que es un pago recurrente y con
 * qué frecuencia — nunca se registra como un movimiento suelto sin más.
 */
function conEtiquetaRecurrencia(concepto: string, tipo: PropuestaPagoRecurrente["tipo"]): string {
  return `${concepto} (recurrente ${tipo})`;
}

async function answerCallbackQuerySafe(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    console.error("[pagoRecurrenteCallbackHandler] No se pudo responder el callback_query (no crítico):", error);
  }
}

/**
 * Maneja los botones sobre alertas de pagos recurrentes (recpago_indicar,
 * recpago_confirmar, recpago_cancelar). El único camino que escribe algo
 * real (Holded + cashflow) es recpago_confirmar, y solo después de que el
 * usuario ya vio el monto y proveedor resueltos en un mensaje de
 * confirmación previo.
 */
export async function handlePagoRecurrenteCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  if (!data) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, id] = data.split(":");

  if (accion === "recpago_indicar") {
    const chatId = callback.message?.chat.id;
    const messageId = callback.message?.message_id;

    if (!chatId || !messageId) {
      await answerCallbackQuerySafe(callback.id, "No se pudo identificar el mensaje original.");
      return;
    }

    const entrada = obtenerEntradaPorId(id);
    if (!entrada || !entrada.empresaHolded) {
      await answerCallbackQuerySafe(callback.id, "Esta entrada ya no está disponible.");
      return;
    }

    const fechaISO = calcularProximaFecha(entrada).toISOString().slice(0, 10);

    await answerCallbackQuerySafe(callback.id);

    const pregunta = entrada.proveedor
      ? `💰 Ok — ¿cuál es el importe exacto de "${entrada.concepto}" (proveedor: ${entrada.proveedor})?`
      : `💰 Ok — ¿cuál es el importe exacto de "${entrada.concepto}" y quién es el proveedor (ej. "180€, Mapfre")?`;

    await editTelegramMessage(chatId, messageId, pregunta, []);

    await guardarPendienteMontoPago({
      chatId,
      messageId,
      entradaId: entrada.id ?? id,
      concepto: entrada.concepto,
      tipo: entrada.tipo,
      empresaHolded: entrada.empresaHolded,
      proveedor: entrada.proveedor,
      fechaVencimiento: fechaISO,
    });
    return;
  }

  if (accion === "recpago_cancelar") {
    const propuesta = await consumirPropuestaPagoRecurrente(id);
    await answerCallbackQuerySafe(callback.id, "Descartado.");
    if (propuesta) {
      await editTelegramMessage(
        propuesta.chatId,
        propuesta.messageId,
        `❌ Descartado — ${propuesta.concepto} (${propuesta.monto.toFixed(2)} €)`,
        []
      );
    }
    return;
  }

  if (accion === "recpago_confirmar") {
    const propuesta = await consumirPropuestaPagoRecurrente(id);
    if (!propuesta) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
      return;
    }

    const tieneCashflow = propuesta.empresaHolded === "WOBA" || propuesta.empresaHolded === "EWORKS";

    await answerCallbackQuerySafe(callback.id, "Registrando...");
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `🔄 Registrando "${propuesta.concepto}" en Holded${tieneCashflow ? " y cashflow" : ""}...`,
      []
    );

    try {
      const contacto = await buscarContactoHolded(propuesta.empresaHolded, propuesta.proveedor);
      if (!contacto) {
        await editTelegramMessage(
          propuesta.chatId,
          propuesta.messageId,
          `⚠️ No encontré el proveedor "${propuesta.proveedor}" en los contactos de Holded (${propuesta.empresaHolded}). ` +
            `Créalo primero en Holded y vuelve a intentarlo — no quiero adivinar a qué contacto asignar el gasto.`,
          []
        );
        return;
      }

      const conceptoEtiquetado = conEtiquetaRecurrencia(propuesta.concepto, propuesta.tipo);

      const gasto = await crearGastoHolded(propuesta.empresaHolded, {
        contactId: contacto.id,
        fecha: propuesta.fechaVencimiento,
        descripcion: conceptoEtiquetado,
        // Pagos recurrentes no traen desglose de IVA (el monto lo da el
        // usuario a mano, no una factura leída) — una sola línea al 0%,
        // igual que el comportamiento anterior.
        lineas: [{ concepto: conceptoEtiquetado, base: propuesta.monto, tipoIvaPct: 0 }],
      });

      // Footprint no tiene cashflow en Sheets (ver revisarHoldedVsCashflow.ts
      // y project_footprint_cashflow_separado) — para esa empresa el registro
      // se queda solo en Holded, nunca se intenta escribir una línea que no
      // tiene dónde ir.
      let lineaCashflow = "";
      if (tieneCashflow) {
        const resultadoCashflow = await registrarMovimientoEnSheet({
          bloque: "pagos_extras",
          cliente_o_concepto: conceptoEtiquetado,
          semana: weekLabel(new Date(propuesta.fechaVencimiento)),
          valor: propuesta.monto,
          empresa: propuesta.empresaHolded as "WOBA" | "EWORKS",
        });
        lineaCashflow = `\nCashflow: ${resultadoCashflow.mensaje}`;
      }

      await editTelegramMessage(
        propuesta.chatId,
        propuesta.messageId,
        `✅ Registrado — ${propuesta.concepto} (${propuesta.monto.toFixed(2)} €, ${formatDateLocal(new Date(propuesta.fechaVencimiento))})\n\n` +
          `Holded: gasto creado (id ${gasto.id}, contacto ${contacto.name ?? propuesta.proveedor}, como borrador/pendiente).${lineaCashflow}`,
        []
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[pagoRecurrenteCallbackHandler] Error registrando pago recurrente:", message);
      await editTelegramMessage(
        propuesta.chatId,
        propuesta.messageId,
        `⚠️ Error al registrar "${propuesta.concepto}" (${propuesta.monto.toFixed(2)} €)\n\n${message}`,
        []
      );
    }
    return;
  }

  await answerCallbackQuerySafe(callback.id);
}

function extraerMonto(texto: string): { valor: number; coincidencia: string } | undefined {
  const m = texto.match(/(\d[\d.,]*\d|\d)/);
  if (!m) return undefined;

  let raw = m[1];
  if (raw.includes(",") && raw.includes(".")) {
    raw = raw.replace(/\./g, "").replace(",", ".");
  } else if (raw.includes(",")) {
    raw = raw.replace(",", ".");
  }

  const valor = Number(raw);
  if (!Number.isFinite(valor) || valor <= 0) return undefined;
  return { valor, coincidencia: m[1] };
}

function extraerProveedor(texto: string, coincidenciaMonto: string): string | undefined {
  const resto = texto
    .replace(coincidenciaMonto, "")
    .replace(/[€$]/g, "")
    .replace(/^[\s,.:\-–]+|[\s,.:\-–]+$/g, "")
    .trim();
  return resto.length > 0 ? resto : undefined;
}

/**
 * Continúa el flujo cuando el usuario responde con el importe (y, si hacía
 * falta, el proveedor) tras pulsar "💰 Indicar monto y registrar". Crea la
 * propuesta durable y muestra un mensaje de confirmación final — todavía no
 * escribe nada en Holded ni cashflow, eso solo pasa al pulsar "Confirmar".
 */
export async function continuarConMontoPago(pendiente: PendienteMontoPago, textoUsuario: string): Promise<void> {
  const montoExtraido = extraerMonto(textoUsuario);

  if (!montoExtraido) {
    throw new Error(
      `No pude identificar un importe en "${textoUsuario}". Respóndeme solo con el número (ej. "180" o "180,50").`
    );
  }

  const proveedor = pendiente.proveedor ?? extraerProveedor(textoUsuario, montoExtraido.coincidencia);

  if (!proveedor) {
    throw new Error(
      `No pude identificar el proveedor en "${textoUsuario}". Respóndeme con el importe y el proveedor (ej. "180€, Mapfre").`
    );
  }

  const propuesta = await crearPropuestaPagoRecurrente({
    empresaHolded: pendiente.empresaHolded,
    concepto: pendiente.concepto,
    tipo: pendiente.tipo,
    proveedor,
    monto: montoExtraido.valor,
    fechaVencimiento: pendiente.fechaVencimiento,
    chatId: pendiente.chatId,
    messageId: 0,
  });

  const tieneCashflow = propuesta.empresaHolded === "WOBA" || propuesta.empresaHolded === "EWORKS";

  const texto = [
    `✅ Confirmar registro de pago recurrente:`,
    ``,
    `Concepto: ${propuesta.concepto}`,
    `Periodicidad: ${propuesta.tipo}`,
    `Empresa: ${propuesta.empresaHolded}`,
    `Proveedor: ${propuesta.proveedor}`,
    `Importe: ${propuesta.monto.toFixed(2)} €`,
    `Fecha: ${formatDateLocal(new Date(propuesta.fechaVencimiento))}`,
    ``,
    tieneCashflow
      ? `Al confirmar se crea el gasto en Holded (como borrador) y la línea en cashflow, ambos etiquetados como "(recurrente ${propuesta.tipo})".`
      : `Al confirmar se crea el gasto en Holded (como borrador), etiquetado "(recurrente ${propuesta.tipo})" — Footprint no tiene cashflow en Sheets, así que no se registra ninguna línea ahí.`,
  ].join("\n");

  const messageId = await sendTelegramMessageWithButtons(pendiente.chatId, texto, [
    [
      { text: "✅ Confirmar y registrar", callback_data: `recpago_confirmar:${propuesta.id}` },
      { text: "❌ Cancelar", callback_data: `recpago_cancelar:${propuesta.id}` },
    ],
  ]);

  await actualizarMessageIdPagoRecurrente(propuesta.id, messageId);
}

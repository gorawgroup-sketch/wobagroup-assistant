import { unlink } from "node:fs/promises";
import { answerCallbackQuery, editTelegramMessage, sendTelegramMessage } from "../telegram/client";
import { consumirPropuestaGasto, obtenerPropuestaGasto, type PropuestaGasto } from "./gastoProposalSheet";
import { guardarPendienteCorreccionGasto, type PendienteCorreccionGasto } from "./pendienteCorreccionGastoStore";
import { registrarClasificacionAprendida } from "./clasificacionAprendidaSheet";
import { buscarContactoHolded, crearGastoHolded, adjuntarComprobanteHolded } from "../holded/write";
import { obtenerRolUsuario } from "../telegram/authorizedUsersSheet";
import type { TelegramCallbackQuery } from "../telegram/types";

async function answerCallbackQuerySafe(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    console.error("[gastoCallbackHandler] No se pudo responder el callback_query (no crítico):", error);
  }
}

async function limpiarArchivoLocal(rutaLocal: string): Promise<void> {
  await unlink(rutaLocal).catch(() => {}); // no crítico si ya no existe
}

/** Adjunta el comprobante a un gasto de Holded y borra la copia local temporal (solo si tuvo éxito). */
async function adjuntarYLimpiar(propuesta: PropuestaGasto, purchaseId: string): Promise<void> {
  await adjuntarComprobanteHolded(
    propuesta.empresa,
    purchaseId,
    propuesta.rutaLocal,
    propuesta.nombreArchivoOriginal,
    propuesta.mimeType
  );
  await limpiarArchivoLocal(propuesta.rutaLocal);
}

/**
 * Maneja los botones de propuestas de gasto (gasto_adjuntar / gasto_nuevo /
 * gasto_corregir / gasto_cancelar). Los únicos caminos que escriben algo
 * real en Holded son gasto_adjuntar y gasto_nuevo (y la confirmación tras
 * gasto_corregir) — nunca ocurre automáticamente.
 */
export async function handleGastoCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  if (!data) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, propuestaId, extra] = data.split(":");

  if (accion === "gasto_cancelar") {
    const propuesta = await consumirPropuestaGasto(propuestaId);
    await answerCallbackQuerySafe(callback.id, "Cancelado.");
    if (propuesta) {
      await limpiarArchivoLocal(propuesta.rutaLocal);
      await editTelegramMessage(
        propuesta.chatId,
        propuesta.messageId,
        `❌ Cancelado — ${propuesta.proveedor} (${propuesta.monto} ${propuesta.moneda})`,
        []
      );
    }
    return;
  }

  if (accion === "gasto_corregir") {
    const propuesta = await obtenerPropuestaGasto(propuestaId);
    if (!propuesta) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
      return;
    }

    await answerCallbackQuerySafe(callback.id);
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `✏️ Ok — dime la empresa y el concepto correctos (ej. "EWORKS, servicio de limpieza").`,
      []
    );
    await guardarPendienteCorreccionGasto(propuesta.chatId, propuesta.id);
    return;
  }

  if (accion === "gasto_adjuntar" || accion === "gasto_nuevo") {
    const propuesta = await consumirPropuestaGasto(propuestaId);
    if (!propuesta) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
      return;
    }

    await answerCallbackQuerySafe(callback.id, "Procesando...");
    await editTelegramMessage(propuesta.chatId, propuesta.messageId, `🔄 Procesando "${propuesta.proveedor}"...`, []);

    try {
      if (accion === "gasto_adjuntar") {
        const indice = Number(extra);
        const candidato = propuesta.candidatos[indice];
        if (!candidato) {
          throw new Error(`No se encontró el candidato #${indice + 1}.`);
        }

        await adjuntarYLimpiar(propuesta, candidato.id);
        await registrarClasificacionAprendida(propuesta.proveedor, propuesta.empresa, propuesta.concepto);

        await editTelegramMessage(
          propuesta.chatId,
          propuesta.messageId,
          `✅ Comprobante adjuntado al gasto de ${candidato.contactName} (${candidato.total.toFixed(2)} €, ${candidato.fecha}) en Holded.`,
          []
        );
      } else {
        await crearYAdjuntar(propuesta, propuesta.empresa, propuesta.concepto);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[gastoCallbackHandler] Error procesando gasto:", message);
      await editTelegramMessage(
        propuesta.chatId,
        propuesta.messageId,
        `⚠️ Error procesando "${propuesta.proveedor}"\n\n${message}\n\nEl archivo local no se borró — puedes reenviarlo.`,
        []
      );
    }
    return;
  }

  await answerCallbackQuerySafe(callback.id);
}

/** Crea el gasto en Holded, le adjunta el comprobante, y reporta el resultado editando el mensaje. */
async function crearYAdjuntar(propuesta: PropuestaGasto, empresaFinal: PropuestaGasto["empresa"], conceptoFinal: string): Promise<void> {
  const contacto = await buscarContactoHolded(empresaFinal, propuesta.proveedor);
  if (!contacto) {
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `⚠️ No encontré el proveedor "${propuesta.proveedor}" en los contactos de Holded (${empresaFinal}). ` +
        `Créalo primero en Holded y vuelve a mandar la factura — no quiero adivinar a qué contacto asignarlo.`,
      []
    );
    return;
  }

  const gasto = await crearGastoHolded(empresaFinal, {
    contactId: contacto.id,
    fecha: propuesta.fecha || new Date().toISOString().slice(0, 10),
    descripcion: conceptoFinal || propuesta.concepto,
    importe: propuesta.monto,
  });

  await adjuntarYLimpiar(propuesta, gasto.id);
  await registrarClasificacionAprendida(propuesta.proveedor, empresaFinal, conceptoFinal || propuesta.concepto);

  await editTelegramMessage(
    propuesta.chatId,
    propuesta.messageId,
    `✅ Gasto creado en Holded (id ${gasto.id}, contacto ${contacto.name ?? propuesta.proveedor}, como borrador) ` +
      `y comprobante adjuntado.`,
    []
  );
}

/**
 * Continúa el flujo cuando el usuario responde con la corrección tras
 * pulsar "✏️ Corregir clasificación".
 */
export async function continuarConCorreccionGasto(pendiente: PendienteCorreccionGasto, textoUsuario: string): Promise<void> {
  // La corrección termina creando/escribiendo un gasto en Holded — mismo
  // filtro de rol que los botones de escritura (esAccionSensible en
  // server.ts), necesario aquí también porque este camino se dispara por
  // texto libre, no por un callback_data que ese filtro pueda interceptar.
  const rol = await obtenerRolUsuario(pendiente.chatId);
  if (rol !== "admin") {
    await sendTelegramMessage(pendiente.chatId, "Corregir y crear el gasto requiere aprobación de un administrador.");
    return;
  }

  const propuesta = await consumirPropuestaGasto(pendiente.propuestaId);
  if (!propuesta) {
    await sendTelegramMessage(pendiente.chatId, "Esa propuesta ya no está disponible.");
    return;
  }

  const [empresaRaw, ...resto] = textoUsuario.split(",");
  const empresaCorregidaTexto = empresaRaw.trim().toUpperCase();
  const empresaFinal: PropuestaGasto["empresa"] =
    empresaCorregidaTexto === "WOBA" || empresaCorregidaTexto === "EWORKS" ? (empresaCorregidaTexto as PropuestaGasto["empresa"]) : propuesta.empresa;
  const conceptoFinal = resto.join(",").trim() || textoUsuario.trim();

  await sendTelegramMessage(pendiente.chatId, `🔄 Procesando "${propuesta.proveedor}" con la corrección...`);

  try {
    await crearYAdjuntarPublico(propuesta, empresaFinal, conceptoFinal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[gastoCallbackHandler] Error procesando corrección de gasto:", message);
    await sendTelegramMessage(pendiente.chatId, `⚠️ Error: ${message}\n\nEl archivo local no se borró — puedes reenviarlo.`);
  }
}

async function crearYAdjuntarPublico(propuesta: PropuestaGasto, empresaFinal: PropuestaGasto["empresa"], conceptoFinal: string): Promise<void> {
  const contacto = await buscarContactoHolded(empresaFinal, propuesta.proveedor);
  if (!contacto) {
    await sendTelegramMessage(
      propuesta.chatId,
      `⚠️ No encontré el proveedor "${propuesta.proveedor}" en los contactos de Holded (${empresaFinal}). ` +
        `Créalo primero en Holded y vuelve a mandar la factura.`
    );
    return;
  }

  const gasto = await crearGastoHolded(empresaFinal, {
    contactId: contacto.id,
    fecha: propuesta.fecha || new Date().toISOString().slice(0, 10),
    descripcion: conceptoFinal || propuesta.concepto,
    importe: propuesta.monto,
  });

  await adjuntarYLimpiar(propuesta, gasto.id);
  await registrarClasificacionAprendida(propuesta.proveedor, empresaFinal, conceptoFinal || propuesta.concepto);

  await sendTelegramMessage(
    propuesta.chatId,
    `✅ Gasto creado en Holded (id ${gasto.id}, contacto ${contacto.name ?? propuesta.proveedor}, como borrador) y comprobante adjuntado.`
  );
}

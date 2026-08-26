import { sendTelegramMessageWithButtons, sendTelegramMessage } from "../telegram/client";
import { buscarGastoSimilar } from "../holded/write";
import { crearPropuestaGasto, actualizarMessageIdGasto } from "./gastoProposalSheet";
import type { DatosFactura } from "../documental/extractInvoiceData";
import type { Empresa } from "../holded/client";

export interface GastoEntrante {
  chatId: number;
  rutaLocal: string;
  nombreArchivoOriginal: string;
  mimeType?: string;
  datos: DatosFactura;
}

function esEmpresaHolded(empresa: string): empresa is Empresa {
  return empresa === "WOBA" || empresa === "EWORKS";
}

/**
 * A partir de una factura/gasto ya leído (extraerDatosFactura), busca si
 * corresponde a un gasto ya existente en Holded o si hay que proponer uno
 * nuevo, y manda la propuesta con botones — nunca escribe nada en Holded
 * por sí sola, eso ocurre solo en gastoCallbackHandler.ts tras aprobación.
 */
export async function procesarGastoEntrante(entrada: GastoEntrante): Promise<void> {
  const { chatId, datos } = entrada;

  if (!esEmpresaHolded(datos.empresaProbable)) {
    await sendTelegramMessage(
      chatId,
      `📄 Detecté una factura/gasto (${datos.proveedor || "proveedor desconocido"}, ${datos.monto} ${datos.moneda}) ` +
        `pero no tengo clara la empresa (${datos.empresaProbable === "Footprint" ? "Footprint no está integrado con Holded todavía" : "no pude determinarla"}). ` +
        `Dime a qué empresa (WOBA o EWORKS) pertenece si quieres que lo registre en Holded.`
    );
    return;
  }

  const empresa: Empresa = datos.empresaProbable;

  let candidatos: Awaited<ReturnType<typeof buscarGastoSimilar>> = [];
  try {
    candidatos = await buscarGastoSimilar(empresa, {
      proveedor: datos.proveedor,
      monto: datos.monto,
      fecha: datos.fecha || new Date().toISOString().slice(0, 10),
    });
  } catch (error) {
    console.error("[procesarGastoEntrante] Error buscando gasto similar en Holded:", error);
  }

  const propuesta = await crearPropuestaGasto({
    empresa,
    proveedor: datos.proveedor,
    monto: datos.monto,
    moneda: datos.moneda || "EUR",
    fecha: datos.fecha,
    concepto: datos.concepto,
    rutaLocal: entrada.rutaLocal,
    nombreArchivoOriginal: entrada.nombreArchivoOriginal,
    mimeType: entrada.mimeType,
    candidatos,
    chatId,
    messageId: 0,
  });

  let texto: string;
  let botones: { text: string; callback_data: string }[][];

  if (candidatos.length > 0) {
    texto = [
      `📄 *Factura detectada* — ${datos.proveedor} (${datos.monto} ${datos.moneda}, ${datos.fecha}, ${empresa})`,
      `Concepto: ${datos.concepto}`,
      ``,
      `Encontré ${candidatos.length === 1 ? "un gasto" : "estos gastos"} ya registrado(s) en Holded que podría(n) corresponder:`,
      ...candidatos.map(
        (c, i) => `${i + 1}. ${c.contactName} — ${c.total.toFixed(2)} € (${c.fecha}) — ${c.descripcion}`
      ),
      ``,
      `¿Adjunto el comprobante a alguno de estos, o creo un gasto nuevo?`,
    ].join("\n");

    botones = candidatos.map((c, i) => [
      { text: `✅ Es este (#${i + 1})`, callback_data: `gasto_adjuntar:${propuesta.id}:${i}` },
    ]);
    botones.push([{ text: "❌ Ninguno, crear nuevo", callback_data: `gasto_nuevo:${propuesta.id}` }]);
  } else {
    texto = [
      `📄 *Factura detectada* — no encontré ningún gasto ya registrado en Holded que corresponda.`,
      ``,
      `Propuesta para crear un gasto nuevo:`,
      `Empresa: ${empresa}`,
      `Proveedor: ${datos.proveedor}`,
      `Importe: ${datos.monto} ${datos.moneda}`,
      `Fecha: ${datos.fecha}`,
      `Concepto: ${datos.concepto}`,
      `Confianza de la clasificación: ${datos.confianza} (${datos.razon})`,
    ].join("\n");

    botones = [
      [
        { text: "✅ Crear gasto en Holded", callback_data: `gasto_nuevo:${propuesta.id}` },
        { text: "✏️ Corregir clasificación", callback_data: `gasto_corregir:${propuesta.id}` },
      ],
      [{ text: "❌ Cancelar", callback_data: `gasto_cancelar:${propuesta.id}` }],
    ];
  }

  const messageId = await sendTelegramMessageWithButtons(chatId, texto, botones);
  await actualizarMessageIdGasto(propuesta.id, messageId);
}

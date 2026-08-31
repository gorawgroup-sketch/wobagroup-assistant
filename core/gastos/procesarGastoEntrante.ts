import { sendTelegramMessageWithButtons, sendTelegramMessage } from "../telegram/client";
import { buscarGastoSimilar, buscarMovimientoSimilar, inferirCuentaGasto } from "../holded/write";
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
  return empresa === "WOBA" || empresa === "EWORKS" || empresa === "Footprint";
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
        `pero no tengo clara la empresa. Dime a qué empresa (WOBA, EWORKS o Footprint) pertenece si quieres que lo registre en Holded.`
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

  // Solo importa inferir la cuenta contable cuando de verdad vamos a CREAR
  // un gasto nuevo (si ya hay un candidato para adjuntar, ese documento ya
  // tiene su propia cuenta asignada). Pedido explícito de Carlos tras un
  // caso real: un vuelo de Booking.com se creó bajo la cuenta genérica
  // "Otros servicios" en vez de "Gastos de viaje", a pesar de que Footprint
  // ya tenía 159 líneas reales de gastos de viaje bajo la misma cuenta.
  const cuentaSugerida =
    candidatos.length === 0
      ? await inferirCuentaGasto(empresa, { proveedor: datos.proveedor, concepto: datos.concepto }).catch((error) => {
          console.error("[procesarGastoEntrante] Error infiriendo cuenta contable (no crítico):", error);
          return undefined;
        })
      : undefined;

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
    lineas: datos.lineas,
    chatId,
    messageId: 0,
    cuentaId: cuentaSugerida?.accountId,
    cuentaTags: cuentaSugerida?.tags,
  });

  const desgloseIva = datos.lineas
    .map((l) => `  • ${l.concepto || "(línea)"}: ${l.base.toFixed(2)} € + IVA ${l.tipoIvaPct}%`)
    .join("\n");

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
    // No hay un documento de compra ya cargado en Holded que coincida, pero
    // eso no significa que el gasto sea nuevo de verdad — puede que el
    // cargo YA esté en el banco (Holded lo sincronizó) y solo falte
    // registrarlo en el área de Compras. Se busca ANTES de proponer, para
    // saber si hay que pedir aprobación en dos pasos (crear, revisar, y
    // solo DESPUÉS preguntar si conciliar) o si ya hay confianza suficiente
    // para ofrecer "crear y conciliar" de una — pedido explícito de Carlos
    // tras un caso real (factura de Booking.com sin match de compra, pero
    // sí había un cargo real en el banco).
    let movimientoBancario: Awaited<ReturnType<typeof buscarMovimientoSimilar>>[number] | undefined;
    try {
      const candidatosMov = await buscarMovimientoSimilar(empresa, {
        monto: datos.monto,
        fecha: datos.fecha || new Date().toISOString().slice(0, 10),
      });
      if (candidatosMov.length === 1) movimientoBancario = candidatosMov[0];
    } catch (error) {
      console.error("[procesarGastoEntrante] Error buscando movimiento bancario similar:", error);
    }

    const notaMovimiento = movimientoBancario
      ? `\n\n💳 Encontré un movimiento bancario real sin conciliar que coincide en monto y fecha: ` +
        `"${movimientoBancario.descripcion || "(sin descripción)"}" — ${movimientoBancario.monto.toFixed(2)} € ` +
        `(${movimientoBancario.fecha}). El cargo ya está en el banco, solo falta registrarlo en Compras.`
      : "";

    const notaCuenta = cuentaSugerida
      ? `\nCuenta contable: ${cuentaSugerida.ejemplo ? `misma que "${cuentaSugerida.ejemplo}"` : cuentaSugerida.accountId}` +
        ` (${cuentaSugerida.aprendidoDe === "proveedor" ? "por proveedor" : cuentaSugerida.aprendidoDe === "concepto" ? "por concepto" : "elegida por IA"})` +
        (cuentaSugerida.tags.length > 0 ? `, tags: ${cuentaSugerida.tags.join(", ")}` : "")
      : `\nCuenta contable: no encontré una categoría real parecida ya en uso — Holded usará su cuenta por defecto.`;

    texto = [
      `📄 *Factura detectada* — no encontré ningún gasto ya registrado en Holded que corresponda.`,
      ``,
      `Propuesta para crear un gasto nuevo:`,
      `Empresa: ${empresa}`,
      `Proveedor: ${datos.proveedor}`,
      `Importe: ${datos.monto} ${datos.moneda}`,
      `Fecha: ${datos.fecha}`,
      `Concepto: ${datos.concepto}`,
      `Desglose de IVA:`,
      desgloseIva,
      `Confianza de la clasificación: ${datos.confianza} (${datos.razon})`,
    ].join("\n") + notaCuenta + notaMovimiento;

    botones = [
      [
        movimientoBancario
          ? { text: "✅ Crear y conciliar", callback_data: `gasto_nuevo_conciliar:${propuesta.id}` }
          : { text: "✅ Crear gasto en Holded", callback_data: `gasto_nuevo:${propuesta.id}` },
        { text: "✏️ Corregir clasificación", callback_data: `gasto_corregir:${propuesta.id}` },
      ],
      [{ text: "❌ Cancelar", callback_data: `gasto_cancelar:${propuesta.id}` }],
    ];
  }

  const messageId = await sendTelegramMessageWithButtons(chatId, texto, botones);
  await actualizarMessageIdGasto(propuesta.id, messageId);
}

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

  // Pedido explícito de Carlos, tras un error real (un gasto de Uber en
  // Colombia se registró con 148.346 — el monto en COP — tratado como si
  // fueran EUR, un error de más de 148.000€): la conciliación bancaria del
  // grupo SIEMPRE es en euros, así que si la factura viene en otra moneda,
  // hay que usar el equivalente en EUR para crear el gasto (para que se
  // pueda conciliar), y dejar el comprobante original tal cual está (en su
  // moneda real) — nunca registrar el monto extranjero como si fuera EUR.
  // Si el documento no trae el equivalente en euros impreso, se pregunta en
  // vez de calcular un tipo de cambio inventado.
  const monedaOriginal = (datos.moneda || "EUR").toUpperCase().trim();
  const esMonedaExtranjera = monedaOriginal !== "" && monedaOriginal !== "EUR";

  if (esMonedaExtranjera && datos.montoEUR === undefined) {
    await sendTelegramMessage(
      chatId,
      `📄 Detecté una factura en ${monedaOriginal} — ${datos.proveedor || "proveedor desconocido"}, ` +
        `${datos.monto} ${monedaOriginal} (${datos.fecha || "sin fecha"}, ${empresa}) — pero el documento no trae ` +
        `el equivalente en euros. La conciliación bancaria siempre es en euros, así que necesito el monto EXACTO ` +
        `en euros que salió de la cuenta (no voy a calcular un tipo de cambio yo mismo) antes de registrar nada. ` +
        `¿Cuánto fue en euros?`
    );
    return;
  }

  const montoParaHolded = esMonedaExtranjera ? (datos.montoEUR as number) : datos.monto;
  const lineasParaHolded = esMonedaExtranjera
    ? [{ concepto: datos.concepto, base: montoParaHolded, tipoIvaPct: 0 }]
    : datos.lineas;

  let candidatos: Awaited<ReturnType<typeof buscarGastoSimilar>> = [];
  try {
    candidatos = await buscarGastoSimilar(empresa, {
      proveedor: datos.proveedor,
      monto: montoParaHolded,
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

  // Pedido explícito de Carlos, tras un caso real: un gasto de Uber de
  // Alejandro se etiquetó "Kelly" porque cuentaSugerida.tags solo repite el
  // tag más frecuente HISTÓRICAMENTE en esa cuenta contable, sin relación
  // con quién hizo ESTE gasto en particular. Cuando se identifica con
  // evidencia real la persona de ESTA transacción (remitente original de un
  // correo reenviado, o un nombre en el propio documento), ese tag manda
  // sobre el histórico.
  const tagsFinal = datos.personaAsociada ? [datos.personaAsociada] : cuentaSugerida?.tags;

  const conceptoConMonedaOriginal = esMonedaExtranjera
    ? `${datos.concepto} (${datos.monto} ${monedaOriginal}, comprobante en ${monedaOriginal})`
    : datos.concepto;

  const propuesta = await crearPropuestaGasto({
    empresa,
    proveedor: datos.proveedor,
    monto: montoParaHolded,
    moneda: "EUR",
    fecha: datos.fecha,
    concepto: conceptoConMonedaOriginal,
    rutaLocal: entrada.rutaLocal,
    nombreArchivoOriginal: entrada.nombreArchivoOriginal,
    mimeType: entrada.mimeType,
    candidatos,
    lineas: lineasParaHolded,
    chatId,
    messageId: 0,
    cuentaId: cuentaSugerida?.accountId,
    cuentaTags: tagsFinal,
  });

  const desgloseIva = lineasParaHolded
    .map((l) => `  • ${l.concepto || "(línea)"}: ${l.base.toFixed(2)} € + IVA ${l.tipoIvaPct}%`)
    .join("\n");

  const importeTexto = esMonedaExtranjera
    ? `${montoParaHolded.toFixed(2)} € (comprobante en ${datos.monto} ${monedaOriginal})`
    : `${datos.monto} ${datos.moneda}`;

  let texto: string;
  let botones: { text: string; callback_data: string }[][];

  if (candidatos.length > 0) {
    texto = [
      `📄 *Factura detectada* — ${datos.proveedor} (${importeTexto}, ${datos.fecha}, ${empresa})`,
      `Concepto: ${conceptoConMonedaOriginal}`,
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
    // Pedido explícito de Carlos: nunca quedarse callado sobre si se pudo
    // identificar el movimiento bancario — decir siempre qué se encontró
    // (uno, varios, o ninguno) y, si hace falta algo para confirmarlo,
    // preguntarlo explícitamente en vez de omitirlo en silencio.
    // Pedido explícito de Carlos: esto puede pasar con cualquier moneda
    // (EUR, USD...), no solo COP — cuando el gasto original no está en EUR,
    // el monto en EUR de la factura y el que calcula Holded para el
    // movimiento bancario vienen de dos conversiones de cambio
    // independientes y pueden diferir sin dejar de ser la misma
    // transacción, así que se ensancha la tolerancia (2% del monto) solo en
    // este caso — nunca para gastos que ya estaban en EUR. Sin piso alto
    // fijo: un piso de 1€ resultó demasiado ancho para cargos pequeños
    // (verificado en vivo: con un movimiento real de -2,50€, un piso de 1€
    // hacía match con 6 movimientos distintos del mismo rango de fechas en
    // vez de solo el correcto) — 0,05€ de piso alcanza para el redondeo
    // real sin volverse impreciso en montos chicos.
    const toleranciaMov = esMonedaExtranjera ? Math.max(0.05, montoParaHolded * 0.02) : undefined;

    let movimientoBancario: Awaited<ReturnType<typeof buscarMovimientoSimilar>>[number] | undefined;
    let candidatosMovAmbiguos: Awaited<ReturnType<typeof buscarMovimientoSimilar>> = [];
    try {
      const candidatosMov = await buscarMovimientoSimilar(
        empresa,
        { monto: montoParaHolded, fecha: datos.fecha || new Date().toISOString().slice(0, 10) },
        toleranciaMov
      );
      if (candidatosMov.length === 1) movimientoBancario = candidatosMov[0];
      else if (candidatosMov.length > 1) candidatosMovAmbiguos = candidatosMov;
    } catch (error) {
      console.error("[procesarGastoEntrante] Error buscando movimiento bancario similar:", error);
    }

    const notaAproximacion = esMonedaExtranjera
      ? ` (monto aproximado — la factura está en ${monedaOriginal} y el banco convierte a EUR con su propio ` +
        `tipo de cambio, puede diferir unos céntimos del valor exacto)`
      : "";

    const notaMovimiento = movimientoBancario
      ? `\n\n💳 Encontré un movimiento bancario real sin conciliar que coincide en monto y fecha: ` +
        `"${movimientoBancario.descripcion || "(sin descripción)"}" — ${movimientoBancario.monto.toFixed(2)} €${notaAproximacion} ` +
        `(${movimientoBancario.fecha}). El cargo ya está en el banco, solo falta registrarlo en Compras.`
      : candidatosMovAmbiguos.length > 0
        ? `\n\n💳 Encontré ${candidatosMovAmbiguos.length} movimientos bancarios parecidos, no sé cuál es el correcto:\n` +
          candidatosMovAmbiguos
            .map((m) => `  • "${m.descripcion || "(sin descripción)"}" — ${m.monto.toFixed(2)} € (${m.fecha})`)
            .join("\n") +
          `\n¿Cuál corresponde? Dímelo y lo concilio contra ese.`
        : `\n\n💳 No encontré ningún movimiento bancario sin conciliar que coincida con ${importeTexto} ` +
          `cerca del ${datos.fecha} — si ya salió del banco, dime la fecha exacta del cargo o revísalo en Holded.`;

    const notaTags = datos.personaAsociada
      ? `, tags: ${datos.personaAsociada} (identificado en este documento/correo)`
      : cuentaSugerida && cuentaSugerida.tags.length > 0
        ? `, tags: ${cuentaSugerida.tags.join(", ")} (más usados históricamente en esta cuenta, no identifiqué a la persona de este gasto en concreto)`
        : "";

    const notaCuenta = cuentaSugerida
      ? `\nCuenta contable: ${cuentaSugerida.ejemplo ? `misma que "${cuentaSugerida.ejemplo}"` : cuentaSugerida.accountId}` +
        ` (${cuentaSugerida.aprendidoDe === "proveedor" ? "por proveedor" : cuentaSugerida.aprendidoDe === "concepto" ? "por concepto" : "elegida por IA"})` +
        notaTags
      : `\nCuenta contable: no encontré una categoría real parecida ya en uso — Holded usará su cuenta por defecto. Si sabes a qué categoría debería ir (ej. "Gastos de viaje"), dímelo antes de aprobar y lo corrijo.` +
        notaTags;

    texto = [
      `📄 *Factura detectada* — no encontré ningún gasto ya registrado en Holded que corresponda.`,
      ``,
      `Propuesta para crear un gasto nuevo:`,
      `Empresa: ${empresa}`,
      `Proveedor: ${datos.proveedor}`,
      `Importe: ${importeTexto}`,
      `Fecha: ${datos.fecha}`,
      `Concepto: ${conceptoConMonedaOriginal}`,
      `Desglose de IVA:`,
      desgloseIva,
      `Confianza de la clasificación: ${datos.confianza} (${datos.razon})`,
    ].join("\n") + notaCuenta + notaMovimiento;

    // Pedido explícito de Carlos: cuando hay un movimiento bancario
    // confirmado, mostrar SIEMPRE las dos opciones juntas ("Crear" y
    // "Crear y conciliar") y dejar que él elija según su propia confianza
    // en el match — antes el código decidía solo por él (o una u otra,
    // nunca las dos). Sin movimiento confirmado, solo tiene sentido
    // "Crear" (no hay nada que conciliar todavía).
    botones = movimientoBancario
      ? [
          [
            { text: "✅ Crear", callback_data: `gasto_nuevo:${propuesta.id}` },
            { text: "✅ Crear y conciliar", callback_data: `gasto_nuevo_conciliar:${propuesta.id}` },
          ],
          [{ text: "✏️ Corregir clasificación", callback_data: `gasto_corregir:${propuesta.id}` }],
          [{ text: "❌ Cancelar", callback_data: `gasto_cancelar:${propuesta.id}` }],
        ]
      : [
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

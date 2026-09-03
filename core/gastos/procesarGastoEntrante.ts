import { sendTelegramMessageWithButtons, sendTelegramMessage } from "../telegram/client";
import {
  buscarGastoSimilar,
  buscarMovimientoSimilar,
  buscarMovimientoAproximado,
  inferirCuentaGasto,
  inferirTagsCategoria,
  obtenerMonedasCuentasReales,
} from "../holded/write";
import {
  crearPropuestaGasto,
  actualizarMessageIdGasto,
  buscarPropuestaGastoPendiente,
  actualizarFlagMovimientoBancarioGasto,
} from "./gastoProposalSheet";
import { guardarGastoPendienteDatos } from "./gastoPendienteDatosStore";
import { construirTecladoGasto } from "./gastoTeclado";
import type { DatosFactura } from "../documental/extractInvoiceData";
import type { Empresa } from "../holded/client";

export interface GastoEntrante {
  chatId: number;
  rutaLocal: string;
  nombreArchivoOriginal: string;
  mimeType?: string;
  datos: DatosFactura;
  /** true si este adjunto vino de la cola de revisión de correo uno a uno — ver PropuestaGasto.deColaCorreo. */
  deColaCorreo?: boolean;
  /**
   * Si rutaLocal viene de un adjunto real de Gmail, sus ids — permite volver
   * a descargarlo de la fuente durable si la copia local (tmp/uploads, no
   * sobrevive un redeploy de Railway) se pierde antes de adjuntarlo al gasto
   * en Holded. Ver core/gmail/reDescargarAdjunto.ts.
   */
  origenAdjuntoGmail?: { mensajeIdGmail: string; attachmentIdGmail: string };
  /**
   * Datos del correo del que vino esta factura/gasto — ver
   * PropuestaGasto.correoOrigen (gastoProposalSheet.ts) para el porqué:
   * permite ofrecer, además de registrar el gasto, responder ese correo o
   * guardarlo como conocimiento.
   */
  correoOrigen?: { de: string; asunto: string; threadId: string; messageIdHeader: string; mensajeIdGmail?: string };
}

/**
 * Bug real encontrado en vivo: esta función tiene ramas que solo hacen una
 * pregunta en texto plano (sin botones) y ramas que sí mandan la propuesta
 * completa con botones — antes todas devolvían `void` por igual, así que
 * el llamador (procesarDocumentoLocal) no podía distinguirlas y terminaba
 * confirmándole a Carlos "ya te mandé la propuesta" cuando en realidad solo
 * se le había hecho una pregunta sin ningún botón que aprobar. Nunca
 * reportar un envío que no ocurrió — mismo principio que ya se aplica en
 * reconciliarMovimiento (core/holded/write.ts).
 */
export type ResultadoGastoEntrante = "propuesta_enviada" | "pendiente_datos" | "propuesta_duplicada";

function esEmpresaHolded(empresa: string): empresa is Empresa {
  return empresa === "WOBA" || empresa === "EWORKS" || empresa === "Footprint";
}

/**
 * A partir de una factura/gasto ya leído (extraerDatosFactura), busca si
 * corresponde a un gasto ya existente en Holded o si hay que proponer uno
 * nuevo, y manda la propuesta con botones — nunca escribe nada en Holded
 * por sí sola, eso ocurre solo en gastoCallbackHandler.ts tras aprobación.
 */
export async function procesarGastoEntrante(entrada: GastoEntrante): Promise<ResultadoGastoEntrante> {
  const { chatId, datos } = entrada;

  if (!esEmpresaHolded(datos.empresaProbable)) {
    await sendTelegramMessage(
      chatId,
      `📄 Detecté una factura/gasto (${datos.proveedor || "proveedor desconocido"}, ${datos.monto} ${datos.moneda}) ` +
        `pero no tengo clara la empresa. Dime a qué empresa (WOBA, EWORKS o Footprint) pertenece si quieres que lo registre en Holded.`
    );
    await guardarGastoPendienteDatos({
      chatId,
      rutaLocal: entrada.rutaLocal,
      nombreArchivoOriginal: entrada.nombreArchivoOriginal,
      mimeType: entrada.mimeType,
      datos,
      motivo: "empresa",
      deColaCorreo: entrada.deColaCorreo,
      correoOrigen: entrada.correoOrigen,
    }).catch((error) => console.error("[procesarGastoEntrante] Error guardando pendiente (empresa):", error));
    return "pendiente_datos";
  }

  const empresa: Empresa = datos.empresaProbable;

  // Pedido explícito de Carlos, tras dos errores reales: (1) un gasto de
  // Uber en Colombia se registró con 148.346 — el monto en COP — tratado
  // como si fueran EUR; (2) un gasto de Starbucks en México ("6.41 USD |
  // 109 MXN") se registró con 6.41 tratado como si fueran EUR cuando el
  // correo decía USD explícitamente. La conciliación bancaria necesita el
  // gasto en la moneda REAL de la tarjeta/cuenta que lo pagó — así que si
  // la factura viene en otra moneda (la del comercio, no la de la
  // tarjeta), hay que usar el monto+moneda equivalente que el documento o
  // el correo declaran explícitamente, y dejar el comprobante original tal
  // cual está. Si no hay ningún equivalente explícito, se pregunta en vez
  // de calcular un tipo de cambio inventado.
  //
  // Bug real encontrado en vivo (caso Panamá, Footprint, MERA AEROPUERTO DE
  // PANAMA SA): "moneda extranjera" se definía como "cualquier cosa que no
  // sea EUR" — pero Footprint tiene cuentas de tesorería REALES en EUR, USD
  // Y COP, así que un recibo genuino en USD (17.95 USD, cargado a la cuenta
  // real "FTG USD") NO necesita ningún equivalente: ES el monto real. Carlos
  // ya había confirmado "el documento trae el valor exacto en dólares", pero
  // el código seguía pidiendo un equivalente que no existe ni tiene sentido,
  // dejando el gasto atascado en la misma pregunta en cada reintento. Ahora
  // solo se pide un equivalente cuando la moneda del documento NO coincide
  // con NINGUNA cuenta real de la empresa — nunca por asumir que EUR es la
  // única moneda "propia".
  const monedasReales = await obtenerMonedasCuentasReales(empresa).catch((error) => {
    console.error("[procesarGastoEntrante] Error consultando monedas de cuentas reales (asume solo EUR):", error);
    return new Set(["EUR"]);
  });
  const monedaOriginal = (datos.moneda || "EUR").toUpperCase().trim();
  const esMonedaExtranjera = monedaOriginal !== "" && !monedasReales.has(monedaOriginal);
  const hayEquivalenteExplicito = datos.montoEquivalente !== undefined && Boolean(datos.monedaEquivalente);

  // Pedido explícito de Carlos, tras un caso real: un Uber en Bogotá se
  // pagó con la tarjeta en EUR (el correo de reenvío decía "11.98 euros"
  // en el asunto), pero el comprobante trae el monto en COP — y Footprint
  // SÍ tiene una cuenta real en COP (para otros gastos locales), así que
  // esMonedaExtranjera daba false y el sistema iba a registrar el gasto en
  // COP sin más. "A pesar de que el comprobante está en pesos, el gasto
  // fue hecho en euros" — cuando hay un equivalente EXPLÍCITO (documento o
  // correo), ese es el monto real que salió de la cuenta, con prioridad
  // sobre la moneda del comprobante SIEMPRE que exista — no solo cuando la
  // moneda del comprobante no es válida para NINGUNA cuenta de la empresa.
  // Que la empresa tenga una cuenta real en esa moneda no significa que
  // ESTA tarjeta en particular sea esa cuenta.
  const usarEquivalente = hayEquivalenteExplicito || esMonedaExtranjera;

  if (esMonedaExtranjera && !hayEquivalenteExplicito) {
    const monedasRealesTxt = Array.from(monedasReales).sort().join(", ");
    await sendTelegramMessage(
      chatId,
      `📄 Detecté una factura en ${monedaOriginal} — ${datos.proveedor || "proveedor desconocido"}, ` +
        `${datos.monto} ${monedaOriginal} (${datos.fecha || "sin fecha"}, ${empresa}) — pero ${monedaOriginal} no es ` +
        `ninguna de las monedas de cuenta real que tiene ${empresa} en Holded (${monedasRealesTxt}), y el documento ` +
        `no trae el monto equivalente en alguna de esas monedas. Necesito el monto EXACTO y la moneda que salió de ` +
        `la cuenta real (no voy a calcular un tipo de cambio yo mismo) antes de registrar nada. ¿Cuánto fue, y en qué moneda?`
    );
    await guardarGastoPendienteDatos({
      chatId,
      rutaLocal: entrada.rutaLocal,
      nombreArchivoOriginal: entrada.nombreArchivoOriginal,
      mimeType: entrada.mimeType,
      datos,
      motivo: "moneda",
      deColaCorreo: entrada.deColaCorreo,
      correoOrigen: entrada.correoOrigen,
    }).catch((error) => console.error("[procesarGastoEntrante] Error guardando pendiente (moneda):", error));
    return "pendiente_datos";
  }

  const monedaParaHolded = usarEquivalente ? (datos.monedaEquivalente as string).toUpperCase().trim() : monedaOriginal;
  const montoParaHolded = usarEquivalente ? (datos.montoEquivalente as number) : datos.monto;
  const lineasParaHolded = usarEquivalente
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

  // Bug real encontrado en vivo (2026-09-03): buscarGastoSimilar (arriba)
  // solo mira lo que YA está creado en Holded — nunca las propuestas de
  // "Crear gasto" que siguen pendientes de aprobación. Un correo que se
  // vuelve a marcar como no leído (pedido explícito de Carlos: eso SIEMPRE
  // debe re-analizarse) mandaba una SEGUNDA propuesta sin darse cuenta de
  // que la primera seguía sin resolver — dos botones "Crear" vivos para la
  // MISMA factura, con riesgo real de duplicar el gasto en Holded si se
  // tocan los dos. Antes de mandar una propuesta nueva, se revisa si ya
  // hay una viva para el mismo proveedor/monto.
  const propuestaYaPendiente = await buscarPropuestaGastoPendiente(empresa, datos.proveedor, montoParaHolded).catch((error) => {
    console.error("[procesarGastoEntrante] Error buscando propuesta de gasto ya pendiente (no crítico, sigue igual):", error);
    return undefined;
  });
  if (propuestaYaPendiente) {
    await sendTelegramMessage(
      chatId,
      `📄 "${entrada.nombreArchivoOriginal}" parece la MISMA factura de una propuesta que ya te mandé antes y sigue sin resolver ` +
        `(${propuestaYaPendiente.proveedor} — ${propuestaYaPendiente.monto} ${propuestaYaPendiente.moneda}) — revisa esa antes, no mandé una segunda ` +
        `para no arriesgar un gasto duplicado en Holded.`
    );
    return "propuesta_duplicada";
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
  // sobre el histórico — pero pedido explícito posterior de Carlos: eso NO
  // debe reemplazar el tag de categoría (alimentación/transporte+medio),
  // debe combinarse con él. La categoría se detecta de la naturaleza real
  // de ESTE gasto (concepto/proveedor), nunca del histórico de la cuenta.
  const tagsCategoria = inferirTagsCategoria(datos.concepto, datos.proveedor);
  const tagsPersona = datos.personaAsociada ? [datos.personaAsociada] : (cuentaSugerida?.tags ?? []);
  const tagsFinal = Array.from(new Set([...tagsPersona, ...tagsCategoria]));

  const conceptoConMonedaOriginal = usarEquivalente
    ? `${datos.concepto} (${datos.monto} ${monedaOriginal}, comprobante en ${monedaOriginal})`
    : datos.concepto;

  const propuesta = await crearPropuestaGasto({
    empresa,
    proveedor: datos.proveedor,
    monto: montoParaHolded,
    moneda: monedaParaHolded,
    fecha: datos.fecha,
    numeroDocumento: datos.numeroDocumento,
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
    deColaCorreo: entrada.deColaCorreo,
    origenAdjuntoGmail: entrada.origenAdjuntoGmail,
    correoOrigen: entrada.correoOrigen,
  });

  const desgloseIva = lineasParaHolded
    .map((l) => `  • ${l.concepto || "(línea)"}: ${l.base.toFixed(2)} ${monedaParaHolded} + IVA ${l.tipoIvaPct}%`)
    .join("\n");

  const importeTexto = usarEquivalente
    ? `${montoParaHolded.toFixed(2)} ${monedaParaHolded} (comprobante en ${datos.monto} ${monedaOriginal})`
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

    botones = construirTecladoGasto(propuesta, { numCandidatos: candidatos.length });
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
    // (EUR, USD...), no solo COP — cuando el gasto original no está en la
    // moneda real de la tarjeta, el monto equivalente de la factura y el
    // que registra/calcula Holded para el movimiento bancario pueden
    // diferir sin dejar de ser la misma transacción, así que se ensancha
    // la tolerancia (2% del monto) solo en este caso — nunca para gastos
    // que ya estaban en su moneda real. Sin piso alto fijo: un piso de 1€
    // resultó demasiado ancho para cargos pequeños (verificado en vivo: con
    // un movimiento real de -2,50€, un piso de 1€ hacía match con 6
    // movimientos distintos del mismo rango de fechas en vez de solo el
    // correcto) — 0,05 de piso alcanza para el redondeo real sin volverse
    // impreciso en montos chicos.
    const toleranciaMov = usarEquivalente ? Math.max(0.05, montoParaHolded * 0.02) : undefined;

    let movimientoBancario: Awaited<ReturnType<typeof buscarMovimientoSimilar>>[number] | undefined;
    let candidatosMovAmbiguos: Awaited<ReturnType<typeof buscarMovimientoSimilar>> = [];
    let movimientoAproximado: Awaited<ReturnType<typeof buscarMovimientoAproximado>>[number] | undefined;
    let otrosAproximados = 0;
    try {
      const candidatosMov = await buscarMovimientoSimilar(
        empresa,
        { monto: montoParaHolded, fecha: datos.fecha || new Date().toISOString().slice(0, 10), moneda: monedaParaHolded },
        toleranciaMov
      );
      if (candidatosMov.length === 1) movimientoBancario = candidatosMov[0];
      else if (candidatosMov.length > 1) candidatosMovAmbiguos = candidatosMov;
      else if (datos.proveedor) {
        // Pedido explícito de Carlos tras un caso real: el match exacto (1
        // céntimo de tolerancia) no encuentra nada cuando el equivalente en
        // EUR de la factura es una estimación (ej. conversión desde MXN) y
        // difiere unos céntimos del monto real que calculó el banco — antes
        // de rendirse, busca algo con nombre parecido y monto cercano (no
        // exacto) en vez de decir sin más "no encontré nada". Si hay varios
        // (ej. la misma persona con varios viajes de Uber esa semana), se
        // recomienda el más cercano en monto (ya viene ordenado así) en vez
        // de obligar a elegir entre una lista — "aplicar toda la
        // inteligencia... para llegar a una CONCLUSIÓN y recomendar un gasto
        // aproximado", pedido explícito — y se avisa que hay otros por si
        // ese no es el correcto.
        const candidatosAprox = await buscarMovimientoAproximado(empresa, {
          monto: montoParaHolded,
          fecha: datos.fecha || new Date().toISOString().slice(0, 10),
          moneda: monedaParaHolded,
          proveedor: datos.proveedor,
        });
        if (candidatosAprox.length > 0) {
          movimientoAproximado = candidatosAprox[0];
          otrosAproximados = candidatosAprox.length - 1;
        }
      }
    } catch (error) {
      console.error("[procesarGastoEntrante] Error buscando movimiento bancario similar:", error);
    }

    const notaAproximacion = usarEquivalente
      ? monedaParaHolded === "EUR"
        ? ` (monto aproximado — la factura está en ${monedaOriginal} y el banco convierte a EUR con su propio ` +
          `tipo de cambio, puede diferir unos céntimos del valor exacto)`
        : ` (monto aproximado — puede diferir unos céntimos del valor exacto registrado por el banco)`
      : "";

    const notaMovimiento = movimientoBancario
      ? `\n\n💳 Encontré un movimiento bancario real sin conciliar que coincide en monto y fecha: ` +
        `"${movimientoBancario.descripcion || "(sin descripción)"}" — ${movimientoBancario.monto.toFixed(2)} ${movimientoBancario.moneda}${notaAproximacion} ` +
        `(${movimientoBancario.fecha}). El cargo ya está en el banco, solo falta registrarlo en Compras.`
      : movimientoAproximado
        ? `\n\n💳 No encontré un movimiento EXACTO, pero sí uno parecido — nombre reconocible y monto cercano (diferencia de ` +
          `${movimientoAproximado.diferenciaMonto.toFixed(2)} ${movimientoAproximado.moneda}, probablemente por cómo se calculó el ` +
          `equivalente): "${movimientoAproximado.descripcion || "(sin descripción)"}" — ${movimientoAproximado.monto.toFixed(2)} ` +
          `${movimientoAproximado.moneda} (${movimientoAproximado.fecha}). Si es el mismo cargo, aprueba "Crear y conciliar" — revísalo antes si no estás seguro.` +
          (otrosAproximados > 0
            ? ` (hay ${otrosAproximados} movimiento(s) parecido(s) más de estos días — si este no es el correcto, dímelo y busco entre esos.)`
            : "")
        : candidatosMovAmbiguos.length > 0
          ? `\n\n💳 Encontré ${candidatosMovAmbiguos.length} movimientos bancarios parecidos, no sé cuál es el correcto:\n` +
            candidatosMovAmbiguos
              .map((m) => `  • "${m.descripcion || "(sin descripción)"}" — ${m.monto.toFixed(2)} ${m.moneda} (${m.fecha})`)
              .join("\n") +
            `\n¿Cuál corresponde? Dímelo y lo concilio contra ese.`
          : `\n\n💳 No encontré ningún movimiento bancario sin conciliar que coincida con ${importeTexto}` +
            (datos.proveedor ? " — ni exacto ni aproximado por nombre y monto cercano" : " (búsqueda exacta — no hay nombre de proveedor para buscar aproximado)") +
            ` cerca del ${datos.fecha}. Si ya salió del banco, dime la fecha exacta del cargo o revísalo en Holded.`;

    // A efectos de qué botones ofrecer (abajo), un match aproximado cuenta
    // igual que uno exacto — ya pasó el filtro de nombre+monto, y el texto
    // de arriba ya deja claro que es una sugerencia a confirmar, no un
    // hecho. gasto_nuevo_conciliar vuelve a buscar (exacto y luego
    // aproximado) al momento de conciliar, así que encuentra lo mismo.
    if (movimientoAproximado) movimientoBancario = movimientoAproximado;

    await actualizarFlagMovimientoBancarioGasto(propuesta.id, Boolean(movimientoBancario)).catch((error) =>
      console.error("[procesarGastoEntrante] Error guardando el flag de movimiento bancario (no crítico):", error)
    );

    const notaPersonaTxt = datos.personaAsociada
      ? `${datos.personaAsociada} (identificado en este documento/correo)`
      : cuentaSugerida && cuentaSugerida.tags.length > 0
        ? `${cuentaSugerida.tags.join(", ")} (más usados históricamente en esta cuenta, no identifiqué a la persona de este gasto en concreto)`
        : "";
    const notaCategoriaTxt =
      tagsCategoria.length > 0 ? tagsCategoria.join(", ") : "sin categoría reconocida por palabras clave";
    const notaTags = `, tags: ${[notaPersonaTxt, notaCategoriaTxt].filter(Boolean).join(" + ")}`;

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
    botones = construirTecladoGasto(propuesta, { hayMovimientoBancario: Boolean(movimientoBancario) });
  }

  const messageId = await sendTelegramMessageWithButtons(chatId, texto, botones);
  // Bug real encontrado en la auditoría: si esta escritura (solo guarda el
  // id del mensaje real, para poder editarlo después) fallaba, la excepción
  // se propagaba hacia arriba como si la propuesta NUNCA se hubiera
  // mandado — pero el mensaje con botones YA está en Telegram, es real e
  // irreversible. Un llamador que reacciona a ese error (ej.
  // revisarCorreoNuevo.ts, que cae al análisis genérico de correo si esto
  // lanza) terminaría mandando una SEGUNDA propuesta para el mismo correo,
  // dos botones vivos apuntando al mismo "pendiente" — la misma
  // contaminación cruzada que ya se corrigió para otros casos. Un fallo acá
  // nunca debe hacer parecer que la propuesta no se envió.
  await actualizarMessageIdGasto(propuesta.id, messageId).catch((error) =>
    console.error("[procesarGastoEntrante] Error guardando el messageId real de la propuesta (no crítico — la propuesta ya se mandó):", error)
  );
  return "propuesta_enviada";
}

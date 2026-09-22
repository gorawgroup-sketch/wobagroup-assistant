import { sendTelegramMessageWithButtons, sendTelegramMessage } from "../telegram/client";
import {
  verificarDuplicadoGastoEstricto,
  buscarMovimientoSimilar,
  buscarMovimientoAproximado,
  buscarMovimientoEnMonedaAlternativa,
  inferirCuentaGasto,
  combinarTagsGastoAprendidos,
  inferirTagsCategoria,
  obtenerMonedasCuentasReales,
  type CuentaSugerida,
} from "../holded/write";
import {
  crearPropuestaGasto,
  actualizarMessageIdGasto,
  buscarPropuestaGastoPendiente,
  actualizarFlagMovimientoBancarioGasto,
  actualizarMovimientosAmbiguosPropuestaGasto,
  type PropuestaGasto,
} from "./gastoProposalSheet";
import { guardarGastoPendienteDatos } from "./gastoPendienteDatosStore";
import { botonesVerificacionDuplicadoPendiente } from "./gastoPendienteDatosActions";
import { construirTecladoGasto } from "./gastoTeclado";
import { reenviarPropuestaGasto } from "./reenviarPropuestaGasto";
import { buscarMovimientosPorTipoCambio, describirMovimientoMultimoneda } from "./movimientoMultimoneda";
import {
  obtenerPoliticaMonedaLiquidacion,
  seleccionarMovimientoLiquidacionSeguro,
} from "./monedaLiquidacionProveedor";
import type { DatosFactura } from "../documental/extractInvoiceData";
import type { Empresa } from "../holded/client";
import { esProveedorNoIdentificado } from "../holded/duplicateSignals";
import { buscarGastoProcesadoPorIdentidad } from "./gastoPorCorreoStore";
import { calcularHuellaContenido } from "./identidadGasto";
import { obtenerTasaCambioHistorica, obtenerTasaCambioActual } from "../utils/exchangeRate";

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
  origenAdjuntoGmail?: { mensajeIdGmail: string; attachmentIdGmail: string; /** Identidad ESTABLE entre lecturas del correo (a diferencia de attachmentIdGmail) — ver AdjuntoCorreo.partId en gmail/client.ts. Se usa para "¿ya generó este adjunto un gasto?", nunca para descargar. */ partId?: string };
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
export type ResultadoGastoEntrante =
  | "propuesta_enviada"
  | "pendiente_datos"
  | "propuesta_duplicada"
  | "propuesta_pendiente_existente";

function esEmpresaHolded(empresa: string): empresa is Empresa {
  return empresa === "WOBA" || empresa === "EWORKS" || empresa === "Footprint";
}

/**
 * Normaliza un número de documento para comparar — SOLO mayúsculas y recorta
 * espacios repetidos, nunca quita guiones/puntuación. Corrección real de
 * auditoría: una primera versión quitaba TODA la puntuación ("H5R3-KL" y
 * "h5r3 kl" iguales, deseado), pero eso también igualaba números realmente
 * DISTINTOS cuyo formato solo difiere en dónde va el separador (ej.
 * "2024-001" y "202-4001" quedaban ambos "2024001") — exactamente el caso
 * que esta comparación existe para distinguir. Preferible quedarse corto
 * (algunos números con formato distinto que sí son el mismo no calzan) que
 * decir "es el mismo gasto" de dos gastos reales distintos.
 */
function normalizarNumeroDocumento(n: string | undefined): string {
  return (n ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}

// "00000" es el placeholder literal que este proyecto escribe en Holded cuando ninguna factura trae
// un número real (ver crearGastoHolded en core/holded/write.ts: `number: gasto.numeroDocumento ||
// "00000"`) — hallazgo real de auditoría: sin excluirlo, DOS gastos que NINGUNO tiene número real
// terminaban comparados como "coincide" (mismo "00000"), diciendo "es el mismo gasto" entre dos
// gastos que en realidad no se pueden distinguir por esta vía en absoluto.
const PLACEHOLDER_SIN_NUMERO = "00000";

// Hallazgo real de auditoría xhigh: un ternario en cascada con un "else"
// final ("elegida por IA") le seguía cada rama vieja pero silenciosamente
// absorbía cualquier valor NUEVO de CuentaSugerida["aprendidoDe"] añadido
// después (ej. "correccion_confirmada", agregado esta misma noche) — un
// gasto categorizado por una corrección YA CONFIRMADA por Carlos se le
// mostraba como "elegida por IA", justo lo contrario de lo que pasó.
// Record<..., string> sobre el tipo union completo obliga al compilador a
// fallar si se agrega un valor nuevo a CuentaSugerida sin actualizar este
// mapa — cierra la clase de bug, no solo el caso puntual.
const ETIQUETA_APRENDIDO_DE: Record<CuentaSugerida["aprendidoDe"], string> = {
  proveedor: "por proveedor",
  concepto: "por concepto",
  categoria: "por categoría",
  viaje: "por contexto de viaje/desplazamiento",
  correccion_confirmada: "corrección ya confirmada por ti",
  ia: "elegida por IA",
};

function esNumeroDocumentoUtilizable(normalizado: string): boolean {
  return normalizado !== "" && normalizado !== PLACEHOLDER_SIN_NUMERO;
}

/**
 * Compara el número de documento de la factura entrante contra el de un
 * candidato ya registrado en Holded, o contra el de otra propuesta pendiente
 * — pedido explícito de Carlos: proveedor + monto + fecha cercana por sí
 * solos no bastan para distinguir "ya registré este MISMO gasto" de "son dos
 * gastos reales distintos por el mismo importe" (ej. dos taxis de 20€ en
 * días seguidos, mismo proveedor). "coincide" solo cuando AMBOS números
 * existen (ninguno es el placeholder "00000") y son iguales tras normalizar
 * — la señal más fuerte posible de que es el mismo comprobante. "distinto"
 * cuando ambos existen pero NO coinciden. "desconocido" cuando falta (o es
 * el placeholder) el número de alguno de los dos lados — no hay suficiente
 * evidencia para decidir por esta vía.
 *
 * Esta señal es SOLO informativa — nunca decide sola si bloquear o no una
 * propuesta (ver procesarGastoEntrante.ts): un número mal leído por OCR
 * puede dar "distinto" en la MISMA factura, y una diferencia real de
 * formato puede dar "coincide" entre facturas realmente distintas. Sirve
 * para avisar con más contexto, la decisión final siempre la confirma un
 * humano.
 */
function compararNumeroDocumento(numeroEntrante: string | undefined, candidato: string | undefined): "coincide" | "distinto" | "desconocido" {
  const a = normalizarNumeroDocumento(numeroEntrante);
  const b = normalizarNumeroDocumento(candidato);
  if (!esNumeroDocumentoUtilizable(a) || !esNumeroDocumentoUtilizable(b)) return "desconocido";
  return a === b ? "coincide" : "distinto";
}

/**
 * A partir de una factura/gasto ya leído (extraerDatosFactura), busca si
 * corresponde a un gasto ya existente en Holded o si hay que proponer uno
 * nuevo, y manda la propuesta con botones — nunca escribe nada en Holded
 * por sí sola, eso ocurre solo en gastoCallbackHandler.ts tras aprobación.
 */
export async function procesarGastoEntrante(entrada: GastoEntrante): Promise<ResultadoGastoEntrante> {
  const { chatId, datos } = entrada;

  // Un proveedor ilegible no impide ofrecer la vía autorizada sin contacto.
  // No inventar un nombre: la resolución usa el contacto genérico existente
  // solo cuando el operador elige esa alternativa; se mantienen los controles
  // de empresa, soporte, duplicados y conciliación del flujo habitual.

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
      origenAdjuntoGmail: entrada.origenAdjuntoGmail,
      correoOrigen: entrada.correoOrigen,
    }).catch((error) => console.error("[procesarGastoEntrante] Error guardando pendiente (empresa):", error));
    return "pendiente_datos";
  }

  const empresa: Empresa = datos.empresaProbable;
  const huellaContenido = await calcularHuellaContenido(entrada.rutaLocal).catch((error) => {
    console.error("[procesarGastoEntrante] No se pudo calcular la huella del comprobante (continúa con otras defensas):", error);
    return undefined;
  });

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
  const politicaLiquidacion = obtenerPoliticaMonedaLiquidacion(empresa, datos.proveedor, monedaOriginal);
  let montoEquivalenteResuelto = datos.montoEquivalente;
  let monedaEquivalenteResuelta = datos.monedaEquivalente?.toUpperCase().trim();
  let movimientoLiquidacionUsado: Awaited<ReturnType<typeof buscarMovimientosPorTipoCambio>>[number] | undefined;

  // Regla contable confirmada por Carlos (caso real Anthropic, doc
  // 2599-9467-0883): la factura trae USD, pero la tarjeta/cuenta siempre se
  // carga en EUR. Antes el flujo terminó creando 20,88 USD con tasa 1,16 y
  // vinculando un pago real de 20,88 EUR: Holded mostraba 24,22 pagados y
  // -3,34 pendientes. Para proveedores con política de liquidación nunca se
  // registra la cifra USD como EUR ni se calcula el importe final con el BCE.
  // Si el documento/correo no trae el equivalente EUR, se localiza un único
  // cargo real del mismo proveedor y día; la tasa histórica solo acota la
  // búsqueda y el importe usado es el del banco. Ante ausencia o ambigüedad,
  // se pregunta y no se crea nada.
  if (politicaLiquidacion && monedaEquivalenteResuelta !== politicaLiquidacion.moneda) {
    const fechaBusqueda = datos.fecha || new Date().toISOString().slice(0, 10);
    const candidatosLiquidacion = await buscarMovimientosPorTipoCambio(
      empresa,
      {
        monto: datos.monto,
        moneda: monedaOriginal,
        fecha: fechaBusqueda,
        proveedor: datos.proveedor,
      },
      [politicaLiquidacion.moneda]
    );
    movimientoLiquidacionUsado = seleccionarMovimientoLiquidacionSeguro(
      candidatosLiquidacion,
      datos.proveedor,
      fechaBusqueda,
      politicaLiquidacion.moneda
    );

    if (movimientoLiquidacionUsado) {
      montoEquivalenteResuelto = Math.abs(movimientoLiquidacionUsado.monto);
      monedaEquivalenteResuelta = politicaLiquidacion.moneda;
    } else {
      await guardarGastoPendienteDatos({
        chatId,
        rutaLocal: entrada.rutaLocal,
        nombreArchivoOriginal: entrada.nombreArchivoOriginal,
        mimeType: entrada.mimeType,
        datos,
        motivo: "moneda",
        deColaCorreo: entrada.deColaCorreo,
        origenAdjuntoGmail: entrada.origenAdjuntoGmail,
        correoOrigen: entrada.correoOrigen,
      });
      await sendTelegramMessage(
        chatId,
        `📄 ${empresa} · ${datos.proveedor || "Anthropic"} · ${datos.monto.toFixed(2)} ${monedaOriginal} · ${fechaBusqueda}.\n\n` +
          `La liquidación se registra en ${politicaLiquidacion.moneda} usando el importe real del banco. ` +
          `La búsqueda todavía no permite vincular un cargo disponible de forma inequívoca; esto no demuestra que no se haya cobrado. ` +
          `El movimiento puede estar pendiente de sincronización, ya conciliado o tener varios candidatos.\n\n` +
          `No necesitas calcular ni facilitar el cambio. El documento queda pendiente de comprobación bancaria; ` +
          `al retomarlo se vuelve a buscar el cargo y se comprueba que no exista ya el gasto antes de crearlo.`
      );
      return "pendiente_datos";
    }
  }
  const esMonedaExtranjera = monedaOriginal !== "" && !monedasReales.has(monedaOriginal);
  const hayEquivalenteExplicito =
    montoEquivalenteResuelto !== undefined && Boolean(monedaEquivalenteResuelta);

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
    // Pedido explícito de Carlos, caso real (Footprint, hotel Scandic Holmenkollen Park, 1549 NOK,
    // 2026-09-18): "si es necesario entras al internet y ves la tasa de cambio del día" — antes de
    // preguntar, busca en TODAS las cuentas bancarias reales de la empresa (mismo mecanismo que la
    // rama de política de liquidación de arriba: buscarMovimientosPorTipoCambio usa la tasa histórica
    // SOLO para encontrar candidatos, nunca para inventar el importe — ver el comentario de
    // obtenerTasaCambioHistorica en utils/exchangeRate.ts, "esto NUNCA debe usarse para decidir un
    // monto correcto"). Si hay un único cargo real que coincide, ESE es el monto — no un cálculo.
    const fechaBusquedaFx = datos.fecha || new Date().toISOString().slice(0, 10);
    const candidatosFx = await buscarMovimientosPorTipoCambio(
      empresa,
      { monto: datos.monto, moneda: monedaOriginal, fecha: fechaBusquedaFx, proveedor: datos.proveedor },
      monedasReales
    ).catch((error) => {
      console.error("[procesarGastoEntrante] Error buscando movimientos bancarios por tipo de cambio (se sigue con la pregunta manual):", error);
      return [] as Awaited<ReturnType<typeof buscarMovimientosPorTipoCambio>>;
    });

    if (candidatosFx.length === 1) {
      const unico = candidatosFx[0];
      montoEquivalenteResuelto = Math.abs(unico.monto);
      monedaEquivalenteResuelta = unico.moneda;
      datos.razon =
        (datos.razon ? `${datos.razon} ` : "") +
        `[Resuelto automáticamente contra un único cargo bancario real: ${describirMovimientoMultimoneda(unico)}.]`;
    } else {
      const monedasRealesTxt = Array.from(monedasReales).sort().join(", ");
      let pistas = "";
      if (candidatosFx.length > 1) {
        pistas =
          `\n\nEncontré ${candidatosFx.length} cargos bancarios que podrían corresponder (importe cercano según la tasa ` +
          `de la fecha), pero no pude confirmar cuál sin ambigüedad:\n` +
          candidatosFx.map((c, i) => describirMovimientoMultimoneda(c, i)).join("\n");
      } else {
        const referencias: string[] = [];
        for (const destino of Array.from(monedasReales).sort()) {
          const tasa =
            (await obtenerTasaCambioHistorica(fechaBusquedaFx, monedaOriginal, destino).catch(() => undefined)) ??
            (await obtenerTasaCambioActual(monedaOriginal, destino).catch(() => undefined));
          if (tasa !== undefined) {
            referencias.push(`≈${(datos.monto * tasa).toFixed(2)} ${destino}`);
          }
        }
        if (referencias.length > 0) {
          pistas =
            `\n\nSolo como referencia de la tasa de cambio del día (nunca el cargo real — puede diferir por el ` +
            `spread de la tarjeta, por eso no lo registro directamente): ${referencias.join(" / ")}.`;
        }
      }
      await sendTelegramMessage(
        chatId,
        `📄 Detecté una factura en ${monedaOriginal} — ${datos.proveedor || "proveedor desconocido"}, ` +
          `${datos.monto} ${monedaOriginal} (${datos.fecha || "sin fecha"}, ${empresa}) — pero ${monedaOriginal} no es ` +
          `ninguna de las monedas de cuenta real que tiene ${empresa} en Holded (${monedasRealesTxt}), el documento no ` +
          `trae el monto equivalente en alguna de esas monedas, y no encontré un único cargo bancario real que lo ` +
          `confirme sin ambigüedad.${pistas} Necesito el monto EXACTO y la moneda que salió de la cuenta real (no voy ` +
          `a calcular un tipo de cambio yo mismo) antes de registrar nada. Respóndeme aquí mismo en texto libre con el ` +
          `monto y la moneda (ej. "40.46 EUR") y sigo de inmediato.`
      );
      await guardarGastoPendienteDatos({
        chatId,
        rutaLocal: entrada.rutaLocal,
        nombreArchivoOriginal: entrada.nombreArchivoOriginal,
        mimeType: entrada.mimeType,
        datos,
        motivo: "moneda",
        deColaCorreo: entrada.deColaCorreo,
        origenAdjuntoGmail: entrada.origenAdjuntoGmail,
        correoOrigen: entrada.correoOrigen,
      }).catch((error) => console.error("[procesarGastoEntrante] Error guardando pendiente (moneda):", error));
      return "pendiente_datos";
    }
  }

  const monedaParaHolded = usarEquivalente ? (monedaEquivalenteResuelta as string) : monedaOriginal;
  const montoParaHolded = usarEquivalente ? (montoEquivalenteResuelto as number) : datos.monto;

  // Defensa propia contra reenvíos: los tickets pueden dejar de aparecer en
  // /purchases después de desmarcar "Es una factura de compra". Antes de
  // consultar o proponer nada, revisamos una identidad durable que conserva
  // el mismo archivo y el número legal+proveedor del gasto ya creado.
  let duplicadoInterno: Awaited<ReturnType<typeof buscarGastoProcesadoPorIdentidad>>;
  let candidatoRecuperacion: Awaited<ReturnType<typeof verificarDuplicadoGastoEstricto>>["compras"][number] | undefined;
  try {
    duplicadoInterno = await buscarGastoProcesadoPorIdentidad(empresa, {
      huellaContenido,
      numeroDocumento: datos.numeroDocumento,
      proveedor: datos.proveedor,
      monto: montoParaHolded,
      moneda: monedaParaHolded,
      fecha: datos.fecha,
      concepto: datos.concepto,
    });
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error);
    console.error("[procesarGastoEntrante] Error consultando identidad interna de duplicados:", error);
    await sendTelegramMessage(
      chatId,
      `⚠️ No pude comprobar el registro interno de comprobantes ya procesados (${detalle}). Por seguridad NO propuse ` +
        `crear ni conciliar el gasto. El correo queda pendiente para reintentarlo cuando la verificación vuelva a estar disponible.`
    ).catch(() => {});
    await guardarGastoPendienteDatos({
      chatId,
      rutaLocal: entrada.rutaLocal,
      nombreArchivoOriginal: entrada.nombreArchivoOriginal,
      mimeType: entrada.mimeType,
      datos,
      motivo: "verificacion_duplicado",
      deColaCorreo: entrada.deColaCorreo,
      origenAdjuntoGmail: entrada.origenAdjuntoGmail,
      correoOrigen: entrada.correoOrigen,
    }).catch((errorStore) =>
      console.error("[procesarGastoEntrante] Error guardando el reintento de identidad documental:", errorStore)
    );
    return "pendiente_datos";
  }
  if (duplicadoInterno) {
    // Un registro interno se escribe inmediatamente después del POST para impedir que un
    // reintento cree un segundo gasto. Desde ahí hasta que soporte y conciliación terminan,
    // `completado` sigue en false. Ese estado prueba que el gasto existe, pero NO que el correo
    // esté resuelto: tratarlo como duplicado terminal hacía que la cola marcara el mensaje como
    // leído aunque el gasto hubiese quedado sin archivo o sin conciliar tras una caída.
    if (!duplicadoInterno.registro.completado) {
      // Recupera el MISMO gasto con el flujo uno-a-uno ya aprendido. El
      // candidato queda marcado como recuperación, por lo que el teclado no
      // ofrece crear otro: solo verifica/adjunta el soporte de forma durable
      // y retoma la conciliación. Esto cubre una caída posterior al POST en
      // la que la propuesta original ya se había consumido.
      candidatoRecuperacion = {
        id: duplicadoInterno.registro.gastoId,
        contactName: datos.proveedor,
        fecha: datos.fecha,
        total: montoParaHolded,
        descripcion: datos.concepto,
        documentNumber: datos.numeroDocumento,
        moneda: monedaParaHolded,
        soportePendiente: true,
      };
    } else {
      const motivo = duplicadoInterno.motivo === "mismo_archivo"
        ? "el archivo es exactamente el mismo"
        : "coinciden el número de documento y el proveedor";
      // Pedido explícito de Carlos (2026-09-16): este aviso bloqueaba silenciosamente un gasto sin decir
      // de qué correo o factura se trataba, ni su proveedor/monto/fecha — imposible saber en qué punto
      // quedó el manejo de ese correo sin ir a buscarlo a mano. Se agrega toda la identificación ya
      // disponible en este punto (archivo, correo de origen si vino de Gmail, proveedor, monto, fecha,
      // concepto) en el mismo formato ya usado para el aviso de propuesta duplicada más abajo.
      const origenTxt = entrada.correoOrigen
        ? ` (correo de ${entrada.correoOrigen.de}, asunto "${entrada.correoOrigen.asunto}")`
        : "";
      await sendTelegramMessage(
        chatId,
        `⛔ No propuse crear ni conciliar este gasto: "${entrada.nombreArchivoOriginal}"${origenTxt} — ` +
          `${datos.proveedor || "proveedor desconocido"}, ${datos.monto} ${monedaParaHolded} (${datos.fecha || "sin fecha"})` +
          `${datos.concepto ? `, "${datos.concepto}"` : ""}. Motivo: ${motivo} que en el gasto ${duplicadoInterno.registro.gastoId} ` +
          `de ${duplicadoInterno.registro.empresa}. Ya fue procesado anteriormente, aunque Holded lo oculte de /purchases al convertirlo en ticket.`
      );
      return "propuesta_duplicada";
    }
  }
  // Pedido explícito de Carlos, casos reales ALDI/Ahorramas: un recibo simplificado (sin los datos
  // fiscales de la empresa compradora impresos) no se puede usar legalmente para deducir IVA — se
  // colapsa a un solo importe sin desglosar, igual que ya se hacía para el caso de moneda
  // equivalente. extraerDatosFactura ya fuerza este mismo colapso en `datos.lineas` (defensa en
  // profundidad), pero se repite acá explícitamente para que esta decisión quede clara en el punto
  // donde de verdad se decide qué llega a Holded, sin depender solo de lo que venga ya colapsado.
  const lineasParaHolded =
    usarEquivalente || datos.reciboSimplificado
      ? [
          {
            concepto: datos.concepto,
            base: montoParaHolded,
            tipoIvaPct: 0,
            tratamientoFiscal: "inversion_sujeto_pasivo" as const,
          },
        ]
      : datos.lineas;

  let candidatos: Awaited<ReturnType<typeof verificarDuplicadoGastoEstricto>>["compras"] =
    candidatoRecuperacion ? [candidatoRecuperacion] : [];
  let movimientosYaConciliados: Awaited<ReturnType<typeof verificarDuplicadoGastoEstricto>>["movimientosConciliados"] = [];
  try {
    if (!candidatoRecuperacion) {
      const verificacion = await verificarDuplicadoGastoEstricto(empresa, {
        proveedor: datos.proveedor,
        monto: montoParaHolded,
        fecha: datos.fecha || new Date().toISOString().slice(0, 10),
        moneda: monedaParaHolded,
        numeroDocumento: datos.numeroDocumento,
      });
      candidatos = verificacion.compras;
      movimientosYaConciliados = verificacion.movimientosConciliados;
    }
    // Si hay candidatoRecuperacion, la identidad durable ya fija el gasto
    // exacto. Una búsqueda genérica podría ocultarlo (tickets) o reemplazarlo
    // por uno parecido; la recuperación nunca cambia de purchase id.
  } catch (error) {
    console.error("[procesarGastoEntrante] Error buscando gasto similar en Holded:", error);
    const detalle = error instanceof Error ? error.message : String(error);
    await sendTelegramMessage(
      chatId,
      `⚠️ No pude completar la verificación estricta de duplicados en Holded (${detalle}). Por seguridad NO propuse ni creé el gasto. ` +
        `El correo/documento queda pendiente y se puede reintentar cuando Holded responda correctamente.`
    ).catch(() => {});
    await guardarGastoPendienteDatos({
      chatId,
      rutaLocal: entrada.rutaLocal,
      nombreArchivoOriginal: entrada.nombreArchivoOriginal,
      mimeType: entrada.mimeType,
      datos,
      motivo: "verificacion_duplicado",
      deColaCorreo: entrada.deColaCorreo,
      origenAdjuntoGmail: entrada.origenAdjuntoGmail,
      correoOrigen: entrada.correoOrigen,
    }).catch((errorStore) => console.error("[procesarGastoEntrante] Error guardando reintento de duplicados:", errorStore));
    return "pendiente_datos";
  }

  if (movimientosYaConciliados.length > 0) {
    const proveedorVisible = esProveedorNoIdentificado(datos.proveedor)
      ? "proveedor no identificado en el ticket"
      : datos.proveedor;
    const hayCompraVisible = candidatos.length > 0;
    const todosConConciliacionCompleta = movimientosYaConciliados.every((m) => m.status !== "partial");
    const lineas = movimientosYaConciliados
      .map(
        (m, i) =>
          `${i + 1}. ${m.accountName}: “${m.descripcion}” — ${Math.abs(m.monto).toFixed(2)} ${m.moneda}, ${m.fecha}, ` +
          `estado ${m.status}, coincidencia ${m.nivel}`
      )
      .join("\n");
    const mensajeMovimientoYaConciliado =
      `⛔ No propuse crear este gasto: encontré un movimiento bancario YA CONCILIADO que coincide con ` +
        `${proveedorVisible}, ${montoParaHolded.toFixed(2)} ${monedaParaHolded}, ${datos.fecha}.\n\n${lineas}\n\n` +
        (todosConConciliacionCompleta
          ? `Holded informa además que el importe completo del movimiento ya está conciliado, por lo que no es seguro ni posible `
          : `Holded informa además que el movimiento ya tiene una conciliación aplicada, por lo que no es seguro `) +
        (hayCompraVisible
          ? `volver a conciliarlo automáticamente. Wobi encontró además ${candidatos.length} compra(s) visible(s) compatible(s), así que el gasto ` +
            `queda tratado como duplicado y no se habilita “Crear gasto”.`
          : `volver a conciliarlo automáticamente. Wobi no encontró una compra visible asociada mediante la API, por lo que NO afirma que el gasto ` +
            `esté creado: el movimiento puede estar vinculado a un ticket que la API no lista, a otro documento, o tener un estado incoherente. ` +
            `Abre este movimiento en Holded y revisa qué documento tiene enlazado. Si el vínculo es incorrecto, libéralo allí y dime “ya lo liberé, ` +
            `reintenta”. El correo seguirá pendiente y sin marcar como leído hasta resolver esa relación.`);

    if (hayCompraVisible) {
      await sendTelegramMessage(chatId, mensajeMovimientoYaConciliado);
      return "propuesta_duplicada";
    }

    // Un movimiento ocupado sin una compra visible NO demuestra que el
    // gasto esté resuelto. Tratarlo como `propuesta_duplicada` hacía que la
    // cola de correo lo marcara como leído y perdiera el seguimiento justo
    // en el caso incierto que más necesita revisión. Se persiste como
    // verificación pendiente: el vigilante reconoce esta señal, no repite
    // el análisis ni cobra otra extracción, y el usuario puede retomarlo
    // diciendo que ya revisó/liberó el movimiento.
    const pendiente = await guardarGastoPendienteDatos({
      chatId,
      rutaLocal: entrada.rutaLocal,
      nombreArchivoOriginal: entrada.nombreArchivoOriginal,
      mimeType: entrada.mimeType,
      datos,
      motivo: "verificacion_duplicado",
      deColaCorreo: entrada.deColaCorreo,
      origenAdjuntoGmail: entrada.origenAdjuntoGmail,
      correoOrigen: entrada.correoOrigen,
    });
    await sendTelegramMessageWithButtons(
      chatId,
      mensajeMovimientoYaConciliado,
      botonesVerificacionDuplicadoPendiente(pendiente.id)
    );
    return "pendiente_datos";
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
  // Pedido explícito de Carlos: proveedor+monto parecido NO basta para asumir que es la misma
  // factura — compara también el número de documento para que el aviso sea más inteligente. A
  // propósito, esta comparación SOLO informa, nunca decide si bloquear — hallazgo real de
  // auditoría: un número mal leído por OCR puede dar "distinto" en la MISMA factura (dejaría pasar
  // un duplicado real si eso solo bastara para saltarse el bloqueo), y un formato distinto puede
  // dar "coincide" entre facturas realmente distintas. Sigue bloqueando SIEMPRE que haya una
  // propuesta parecida sin resolver — lo único que cambia es cuánto contexto trae el aviso.
  const comparacionPendiente = propuestaYaPendiente
    ? compararNumeroDocumento(datos.numeroDocumento, propuestaYaPendiente.numeroDocumento)
    : undefined;

  let propuestaPendienteBloqueante: PropuestaGasto | undefined;
  if (propuestaYaPendiente) {
    // Bug real encontrado en vivo (2026-09-07, y confirmado que ya había pasado el 2026-09-02 con
    // otra factura): crearPropuestaGasto guarda la propuesta en Sheets con messageId=0 ANTES de
    // mandar el mensaje real de Telegram (más abajo en esta función) — si algo interrumpe el proceso
    // entre esos dos pasos, la propuesta queda huérfana: existe completa, pero nunca se le mostró
    // nada a Carlos. Sin este chequeo, este mismo bloque le decía "revisa esa antes" señalando un
    // mensaje que jamás existió — sin ninguna vía real para resolverlo. Ahora, si la propuesta
    // encontrada nunca se entregó (messageId=0), se reenvía de una vez en vez de señalar hacia la
    // nada — mismo mecanismo que reenviarBotonesPropuestaGasto.ts (tool conversacional).
    //
    // comparacionPendiente !== "distinto": hallazgo real de auditoría — sin este chequeo, un
    // documento REALMENTE distinto (mismo proveedor+monto, número de documento diferente — el caso
    // real que compararNumeroDocumento existe para distinguir) llegaba acá, se descartaba en
    // silencio, y en su lugar se reenviaba la propuesta huérfana VIEJA como si fuera "esta factura".
    // Cuando el número de documento SÍ difiere, cae al aviso normal de abajo (nunca asume que son la
    // misma solo porque una de las dos está huérfana).
    if (propuestaYaPendiente.messageId === 0 && comparacionPendiente !== "distinto") {
      await reenviarPropuestaGasto(
        propuestaYaPendiente,
        `📄 "${entrada.nombreArchivoOriginal}" — encontré una propuesta ya calculada para esta factura que nunca llegué a mostrarte (se interrumpió el proceso antes de mandarla). Aquí está:`
      );
      return "propuesta_enviada";
    }

    const notaNumeroDocumento =
      comparacionPendiente === "distinto"
        ? ` El número de documento de ESTA factura (${datos.numeroDocumento}) es DISTINTO al de esa propuesta ` +
          `(${propuestaYaPendiente.numeroDocumento}) — podría tratarse de dos gastos reales diferentes por el ` +
          `mismo importe, no necesariamente un duplicado. Resuelve esa propuesta primero (apruébala o descártala) ` +
          `y, si de verdad es un gasto distinto, dímelo explícitamente y me encargo de registrarlo aparte.`
        : comparacionPendiente === "coincide"
          ? ` Además, el número de documento coincide (${datos.numeroDocumento}) — es casi con toda seguridad la misma factura.`
          : "";
    const mismaIdentidadDeCola = Boolean(
      entrada.deColaCorreo &&
      propuestaYaPendiente.deColaCorreo &&
      entrada.correoOrigen?.threadId &&
      propuestaYaPendiente.correoOrigen?.threadId === entrada.correoOrigen.threadId &&
      (!entrada.correoOrigen.mensajeIdGmail ||
        propuestaYaPendiente.correoOrigen?.mensajeIdGmail === entrada.correoOrigen.mensajeIdGmail)
    );
    if (mismaIdentidadDeCola) {
      await sendTelegramMessage(
        chatId,
        `📄 "${entrada.nombreArchivoOriginal}" ya tiene una propuesta visible y pendiente para este mismo correo ` +
          `(${propuestaYaPendiente.proveedor} — ${propuestaYaPendiente.monto.toFixed(2)} ${propuestaYaPendiente.moneda}). ` +
          `No envié otra; resuelve la propuesta existente.${notaNumeroDocumento}`
      );
      return "propuesta_pendiente_existente";
    }

    // La propuesta anterior pertenece a otro origen (o nació fuera de la
    // cola). Este correo necesita su propia acción durable: se crea abajo
    // una propuesta en espera, sin botones de creación, que solo se habilita
    // cuando la anterior ya se resolvió. Así nunca queda UNREAD sin salida y
    // tampoco existen dos botones capaces de crear el mismo gasto a la vez.
    propuestaPendienteBloqueante = propuestaYaPendiente;
  }

  // Solo importa inferir la cuenta contable cuando de verdad vamos a CREAR
  // un gasto nuevo (si ya hay un candidato para adjuntar, ese documento ya
  // tiene su propia cuenta asignada). Pedido explícito de Carlos tras un
  // caso real: un vuelo de Booking.com se creó bajo la cuenta genérica
  // "Otros servicios" en vez de "Gastos de viaje", a pesar de que Footprint
  // ya tenía 159 líneas reales de gastos de viaje bajo la misma cuenta.
  const cuentaSugerida =
    candidatos.length === 0
      ? await inferirCuentaGasto(empresa, {
          proveedor: datos.proveedor,
          concepto: datos.concepto,
          personaAsociada: datos.personaAsociada,
          contextoDeViaje: datos.contextoDeViaje,
          reciboSimplificado: datos.reciboSimplificado,
        }).catch((error) => {
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
  // Hallazgo real de auditoría: cuentaSugerida.tags trae el tag HISTÓRICO de esa cuenta contable —
  // para hospedaje/alquiler de coche eso puede seguir siendo la variante vieja ("alojamiento"/
  // "coche") de antes de estandarizar en "hospedaje"/"alquilercoche" (ver inferirTagsCategoria en
  // core/holded/write.ts). Sin filtrarla, un gasto de hotel terminaba con AMBAS variantes juntas
  // ("alojamiento" Y "hospedaje") — justo la duplicación que se quería evitar al estandarizar. Se
  // descarta la variante vieja cuando la nueva ya viene de tagsCategoria para ESTE gasto.
  const tagsCategoria = inferirTagsCategoria(datos.concepto, datos.proveedor);
  const tagsFinal = combinarTagsGastoAprendidos(
    datos.concepto,
    datos.proveedor,
    datos.personaAsociada,
    cuentaSugerida?.tags
  );

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
    huellaContenido,
  });

  if (propuestaPendienteBloqueante) {
    const textoEspera =
      `📄 "${entrada.nombreArchivoOriginal}" coincide con una propuesta anterior todavía pendiente ` +
      `(${propuestaPendienteBloqueante.proveedor} — ${propuestaPendienteBloqueante.monto.toFixed(2)} ` +
      `${propuestaPendienteBloqueante.moneda}). Para evitar dos creaciones simultáneas, esta segunda queda en espera.\n\n` +
      `Cuando resuelvas la propuesta anterior, pulsa “Verificar y continuar”. Este correo permanecerá sin leer hasta entonces.`;
    const messageId = await sendTelegramMessageWithButtons(chatId, textoEspera, [
      [{ text: "🔎 Verificar y continuar", callback_data: `gasto_espera:${propuesta.id}:${propuestaPendienteBloqueante.id}` }],
      [{ text: "❌ Descartar este correo", callback_data: `gasto_cancelar:${propuesta.id}` }],
    ]);
    await actualizarMessageIdGasto(propuesta.id, messageId);
    return "propuesta_enviada";
  }

  const desgloseIva = lineasParaHolded
    .map(
      (l) =>
        `  • ${l.concepto || "(línea)"}: ${l.base.toFixed(2)} ${monedaParaHolded} + ` +
        (l.tratamientoFiscal === "inversion_sujeto_pasivo" || l.tipoIvaPct === 0
          ? "Inv. Suj. Pasivo"
          : `IVA ${l.tipoIvaPct}%`)
    )
    .join("\n");

  const importeTexto = usarEquivalente
    ? `${montoParaHolded.toFixed(2)} ${monedaParaHolded} (comprobante en ${datos.monto} ${monedaOriginal}` +
      `${movimientoLiquidacionUsado ? "; importe EUR tomado del cargo bancario exacto" : ""})`
    : `${datos.monto} ${datos.moneda}`;
  const etiquetaTipoDocumento = datos.reciboSimplificado ? "Ticket/recibo detectado" : "Factura detectada";
  const notaTicket = datos.reciboSimplificado
    ? `⚠️ Este comprobante es un ticket/recibo simplificado, NO una factura legal. La integración disponible ` +
      `de Holded solo permite crearlo inicialmente como compra; después de aprobar, debes abrir Opciones y ` +
      `desmarcar “Es una factura de compra”. Wobi seguirá reconociendo ese ticket mediante la conciliación ` +
      `bancaria para no volver a registrarlo.`
    : "";

  let texto: string;
  let botones: { text: string; callback_data: string }[][];

  if (candidatos.length > 0) {
    const esRecuperacionIncompleta = candidatos.some((c) => c.soportePendiente || c.conciliacionPendiente);
    // Pedido explícito de Carlos: proveedor+monto+fecha cercana solos no bastan para distinguir "ya
    // registré este MISMO gasto" de "son dos gastos reales distintos por el mismo importe" — compara
    // también el número de documento/comprobante contra cada candidato (ver compararNumeroDocumento).
    // Señal SOLO informativa, nunca decide sola (ver compararNumeroDocumento) — el aviso siempre
    // queda con margen para que un OCR mal leído en cualquiera de los dos lados invierta el
    // resultado, así que ninguna de las dos frases suena 100% categórica.
    const comparaciones = candidatos.map((c) => compararNumeroDocumento(datos.numeroDocumento, c.documentNumber));
    const algunaCoincide = comparaciones.some((r) => r === "coincide");
    const algunaDistinta = comparaciones.some((r) => r === "distinto");

    const avisoNumeroDocumento = esRecuperacionIncompleta
      ? ""
      : algunaCoincide
      ? `⚠️ El número de documento coincide con uno de estos — probablemente sea el MISMO gasto, no uno distinto por el mismo importe (aunque un OCR mal leído también podría coincidir por casualidad). Revísalo bien antes de crear uno nuevo.`
      : algunaDistinta
        ? `${candidatos.length === 1 ? "Este tiene" : "Al menos uno de estos tiene"} un número de documento DISTINTO al de esta factura (${datos.numeroDocumento}) — podría ser un gasto real distinto por el mismo importe, aunque también podría ser el mismo con el número mal leído por OCR en alguno de los dos lados. Revísalo con atención antes de decidir.`
        : "";

    const lineasTexto = [
      `📄 *${etiquetaTipoDocumento}* — ${datos.proveedor} (${importeTexto}, ${datos.fecha}, ${empresa})`,
      `Concepto: ${conceptoConMonedaOriginal}`,
    ];
    if (datos.numeroDocumento) lineasTexto.push(`Número de documento: ${datos.numeroDocumento}`);
    // Hallazgo real de auditoría (caso "JRJ 9 2015 SL"/"Larrauri", mismo gasto real con dos textos de
    // proveedor distintos en dos documentos): cuando buscarGastoSimilar cae a su fallback por
    // monto+fecha (proveedorDistinto=true, ningún candidato coincidió por texto de proveedor), avisar
    // explícitamente — de lo contrario esta lista se ve igual que un match normal por proveedor, y
    // Carlos no tiene forma de saber que el nombre no coincidió y por qué igual se sugiere.
    const algunoProveedorDistinto = candidatos.some((c) => c.proveedorDistinto);
    lineasTexto.push(
      ``,
      esRecuperacionIncompleta
        ? `Este mismo gasto ya fue creado, pero su soporte y conciliación todavía no constan como proceso completo. No se permitirá crear otro:`
        : `Encontré ${candidatos.length === 1 ? "un gasto" : "estos gastos"} ya registrado(s) en Holded que podría(n) corresponder:`,
      ...candidatos.map((c, i) => {
        const notaDoc =
          comparaciones[i] === "coincide"
            ? ` [mismo número de documento: ${c.documentNumber}]`
            : comparaciones[i] === "distinto"
              ? ` [número de documento distinto: ${c.documentNumber}]`
              : c.documentNumber
                ? ` [documento: ${c.documentNumber}]`
                : "";
        return `${i + 1}. ${c.contactName} — ${c.total.toFixed(2)} € (${c.fecha}) — ${c.descripcion}${notaDoc}`;
      })
    );
    if (algunoProveedorDistinto) {
      lineasTexto.push(
        ``,
        `⚠️ El nombre de proveedor de esta factura (${datos.proveedor}) NO coincide con el de ${candidatos.length === 1 ? "este" : "estos"} — se sugiere solo porque coincide el importe exacto y la fecha (mismo día). Puede ser el mismo comercio con otro nombre en cada documento (nombre comercial vs. razón social), o un gasto real distinto por casualidad — revísalo antes de decidir.`
      );
    }
    if (avisoNumeroDocumento) lineasTexto.push(``, avisoNumeroDocumento);
    if (notaTicket) lineasTexto.push(``, notaTicket);
    lineasTexto.push(
      ``,
      esRecuperacionIncompleta
        ? `¿Verifico y termino el soporte y la conciliación de este mismo gasto? El correo seguirá sin leer hasta completarlo.`
        : `¿Adjunto el comprobante a alguno de estos, o creo un gasto nuevo?`
    );

    texto = lineasTexto.join("\n");

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
      if (candidatosMov.length === 1) movimientoBancario = { ...candidatosMov[0], origenCoincidencia: "exacta" };
      else if (candidatosMov.length > 1) candidatosMovAmbiguos = candidatosMov;
      else if (!esProveedorNoIdentificado(datos.proveedor)) {
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
          movimientoAproximado = { ...candidatosAprox[0], origenCoincidencia: "aproximada" };
          otrosAproximados = candidatosAprox.length - 1;
        }
      }
    } catch (error) {
      console.error("[procesarGastoEntrante] Error buscando movimiento bancario similar:", error);
    }

    // Si la factura está en una moneda real de la empresa (por ejemplo USD) pero el cargo salió de
    // otra cuenta (por ejemplo EUR), las búsquedas anteriores no pueden encontrarlo: para monedas
    // distintas de EUR comparan únicamente contra movimientos nativos de esa misma moneda. Se usa
    // ahora la tasa histórica solo como referencia de búsqueda, nunca para cambiar el gasto ni para
    // conciliar automáticamente. Incluso con un único candidato se obliga a elegir "Conciliar con
    // #N", porque la tasa exacta aplicada por el banco puede incluir spread.
    const otrasMonedas = Array.from(monedasReales).filter((m) => m !== monedaParaHolded);
    let movimientosTipoCambio: Awaited<ReturnType<typeof buscarMovimientosPorTipoCambio>> = [];
    if (!movimientoBancario && !movimientoAproximado && candidatosMovAmbiguos.length === 0 && otrasMonedas.length > 0) {
      try {
        movimientosTipoCambio = await buscarMovimientosPorTipoCambio(
          empresa,
          {
            monto: montoParaHolded,
            moneda: monedaParaHolded,
            fecha: datos.fecha || new Date().toISOString().slice(0, 10),
            proveedor: datos.proveedor,
          },
          otrasMonedas
        );
      } catch (error) {
        console.error("[procesarGastoEntrante] Error buscando movimiento por tipo de cambio:", error);
      }
    }

    // Pedido explícito de Carlos, tras un caso real: Kelly reportó por correo un gasto de Uber Eats
    // como "12.71 dólares" — no había ningún movimiento sin conciliar en USD, pero SÍ había uno de
    // exactamente 12.71 € el mismo día. El monto que reportó era correcto, la MONEDA que dijo estaba
    // mal. Solo se prueba cuando la búsqueda normal (exacta y aproximada) ya no encontró nada —
    // nunca reemplaza ni concilia sola, solo avisa para que se confirme antes de crear el gasto.
    let movimientoMonedaAlternativa: Awaited<ReturnType<typeof buscarMovimientoEnMonedaAlternativa>> | undefined;
    if (!movimientoBancario && !movimientoAproximado && candidatosMovAmbiguos.length === 0 && movimientosTipoCambio.length === 0) {
      if (otrasMonedas.length > 0) {
        try {
          movimientoMonedaAlternativa = await buscarMovimientoEnMonedaAlternativa(
            empresa,
            { monto: montoParaHolded, fecha: datos.fecha || new Date().toISOString().slice(0, 10), proveedor: datos.proveedor },
            otrasMonedas
          );
        } catch (error) {
          console.error("[procesarGastoEntrante] Error buscando movimiento en moneda alternativa:", error);
        }
      }
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
              .map((m, i) => `  ${i + 1}. "${m.descripcion || "(sin descripción)"}" — ${m.monto.toFixed(2)} ${m.moneda} (${m.fecha})`)
              .join("\n") +
            `\nMarca "🔗 Conciliar con #N" abajo (o "Crear (sin conciliar)" si ninguno es) y aprueba tu selección.`
          : movimientosTipoCambio.length > 0
            ? `\n\n💱 No apareció el cargo por ${importeTexto}, pero encontré ${movimientosTipoCambio.length === 1 ? "esta alternativa" : "estas alternativas"} ` +
              `en otra moneda/cuenta de ${empresa}, calculando primero el equivalente con la tasa histórica de referencia:\n` +
              movimientosTipoCambio.map((m, i) => describirMovimientoMultimoneda(m, i)).join("\n") +
              `\nMarca "🔗 Conciliar con #N" abajo si reconoces el cargo, o "Crear (sin conciliar)" si ninguno corresponde. ` +
              `Wobi no elegirá ni conciliará por su cuenta una coincidencia cambiaria.`
          : movimientoMonedaAlternativa
            ? `\n\n💱 OJO — posible error de moneda: no encontré ningún movimiento de ${importeTexto}, pero SÍ hay uno de ` +
              `EXACTAMENTE ${movimientoMonedaAlternativa.monto.toFixed(2)} ${movimientoMonedaAlternativa.moneda} el ` +
              `${movimientoMonedaAlternativa.fecha}${movimientoMonedaAlternativa.coincideProveedor ? ` con un proveedor parecido a "${datos.proveedor}"` : ""} ` +
              `("${movimientoMonedaAlternativa.descripcion || "(sin descripción)"}"). El monto reportado parece correcto, pero probablemente la moneda ` +
              `no — es más probable que el cargo real haya sido en ${movimientoMonedaAlternativa.moneda}, no en ${monedaParaHolded}.` +
              (movimientoMonedaAlternativa.otrosCandidatos > 0
                ? ` Ojo: hay ${movimientoMonedaAlternativa.otrosCandidatos} movimiento(s) más en ${movimientoMonedaAlternativa.moneda} igual de parecido(s) — no es un match único, revísalo con más cuidado.`
                : "") +
              ` Confirma la moneda real antes de crear el gasto (no lo crees ni concilies todavía si no estás seguro).`
            : `\n\n💳 No encontré ningún movimiento bancario sin conciliar que coincida con ${importeTexto}` +
              (!esProveedorNoIdentificado(datos.proveedor)
                ? " — ni exacto ni aproximado por nombre y monto cercano"
                : " (búsqueda exacta — no hay un nombre real de proveedor para buscar por similitud)") +
              ` cerca del ${datos.fecha}. Si ya salió del banco, dime la fecha exacta del cargo o revísalo en Holded.`;

    // A efectos de qué botones ofrecer (abajo), un match aproximado cuenta
    // igual que uno exacto. El movimiento recomendado se guarda completo
    // junto con la propuesta: al aprobar “Crear y conciliar” se usa ese
    // mismo accountId/movementId y no se repite una búsqueda mutable.
    if (movimientoAproximado) movimientoBancario = movimientoAproximado;
    const movimientosParaElegir = candidatosMovAmbiguos.length > 0 ? candidatosMovAmbiguos : movimientosTipoCambio;
    const movimientosParaPersistir = movimientoBancario ? [movimientoBancario] : movimientosParaElegir;

    // Estos dos campos forman una sola promesa al operador: mostrar
    // “Crear y conciliar” solo si el movimiento exacto quedó durablemente
    // ligado a la propuesta. Un fallo parcial aborta antes de publicar los
    // botones; nunca se ofrece una acción que después tenga que buscar de
    // nuevo y pueda perder el candidato mostrado.
    const movimientosGuardados = await actualizarMovimientosAmbiguosPropuestaGasto(
      propuesta.id,
      movimientosParaPersistir
    );
    const flagGuardado = await actualizarFlagMovimientoBancarioGasto(propuesta.id, Boolean(movimientoBancario));
    if (!movimientosGuardados || !flagGuardado) {
      throw new Error("No se pudo guardar durablemente el movimiento bancario recomendado.");
    }

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
        ` (${ETIQUETA_APRENDIDO_DE[cuentaSugerida.aprendidoDe]})` +
        notaTags
      : `\nCuenta contable: no encontré una categoría real parecida ya en uso — Holded usará su cuenta por defecto. Si sabes a qué categoría debería ir (ej. "Gastos de viaje"), dímelo antes de aprobar y lo corrijo.` +
        notaTags;

    texto = [
      `📄 *${etiquetaTipoDocumento}* — no encontré ningún gasto ya registrado en Holded que corresponda.`,
      ``,
      `Propuesta para crear un gasto nuevo:`,
      `Empresa: ${empresa}`,
      `Proveedor: ${datos.proveedor}`,
      `Importe: ${importeTexto}`,
      `Fecha: ${datos.fecha}`,
      `Concepto: ${conceptoConMonedaOriginal}`,
      `Tratamiento fiscal:`,
      datos.reciboSimplificado
        ? `${desgloseIva} — recibo simplificado (sin datos fiscales completos), sujeto pasivo.`
        : desgloseIva,
      `Confianza de la clasificación: ${datos.confianza} (${datos.razon})`,
    ].join("\n") + notaCuenta + (notaTicket ? `\n\n${notaTicket}` : "") + notaMovimiento;

    // Pedido explícito de Carlos: cuando hay un movimiento bancario
    // confirmado, mostrar SIEMPRE las dos opciones juntas ("Crear" y
    // "Crear y conciliar") y dejar que él elija según su propia confianza
    // en el match — antes el código decidía solo por él (o una u otra,
    // nunca las dos). Sin movimiento confirmado, solo tiene sentido
    // "Crear" (no hay nada que conciliar todavía).
    botones = construirTecladoGasto(propuesta, {
      hayMovimientoBancario: Boolean(movimientoBancario),
      numMovimientosAmbiguos: movimientosParaElegir.length > 0 ? movimientosParaElegir.length : undefined,
    });
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

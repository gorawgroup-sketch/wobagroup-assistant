import { debeOfrecerSoporteDistinto } from "./soporteDistinto";
import { frenoAvisoPropuesta } from "./avisoPropuestaPendiente";
import { crearTrazaBusqueda, describirTrazaBusqueda } from "../holded/trazaBusqueda";
import { buscarCargoSinFecha, seleccionarFechaBancaria } from "./busquedaSinFecha";
import { esFechaDocumentoValida } from "./fechaDocumento";
import { sendTelegramMessageWithButtons, sendTelegramMessage } from "../telegram/client";
import { esRemitenteDelGrupo } from "./remitenteDelGrupo";
import {
  verificarDuplicadoGastoEstricto,
  buscarMovimientoSimilar,
  buscarMovimientoAproximado,
  buscarCargoMayorDelProveedor,
  buscarMovimientoEnMonedaAlternativa,
  inferirCuentaGasto,
  combinarTagsGastoAprendidos,
  inferirTagsCategoria,
  obtenerMonedasCuentasReales,
  descargarAdjuntosCompraHolded,
  type CuentaSugerida,
} from "../holded/write";
import {
  crearPropuestaGasto,
  actualizarMessageIdGasto,
  buscarPropuestaGastoPendiente,
  type PropuestaGasto,
} from "./gastoProposalSheet";
import { guardarGastoPendienteDatos, obtenerGastosPendienteDatosPorChat } from "./gastoPendienteDatosStore";
import {
  botonesFalloTemporalVerificacionPendiente,
  botonesVerificacionDuplicadoPendiente,
} from "./gastoPendienteDatosActions";
import { guardarVinculoBancarioPropuesta } from "./vinculoBancarioPropuesta";
import { construirTecladoGasto, opcionesTecladoDesdePropuesta } from "./gastoTeclado";
import { reenviarPropuestaGasto } from "./reenviarPropuestaGasto";
import { buscarMovimientosPorTipoCambio, cargoUnicoParaEquivalente, describirMovimientoMultimoneda } from "./movimientoMultimoneda";
import { notaCargosMayores } from "../holded/cargoMayor";
import { equivalenteCuadraConTasa } from "./equivalenteCoherente";
import { empresaNombradaEnTexto } from "./empresaPorComprador";
import { convertirATasa, mejorCargoPorCercania, monedaDestinoPreferida } from "./conversionAutomatica";
import {
  obtenerPoliticaMonedaLiquidacion,
  seleccionarMovimientoLiquidacionSeguro,
} from "./monedaLiquidacionProveedor";
import type { DatosFactura } from "../documental/extractInvoiceData";
import type { Empresa } from "../holded/client";
import { esProveedorNoIdentificado } from "../holded/duplicateSignals";
import { buscarGastoProcesadoPorIdentidad } from "./gastoPorCorreoStore";
import { buscarMismaEstanciaRegistrada } from "./mismaEstanciaRegistrada";
import { calcularHuellaContenido } from "./identidadGasto";
import { obtenerTasaCambioHistorica, obtenerTasaCambioActual } from "../utils/exchangeRate";
import { evaluarPagosMultiples } from "../holded/pagosMultiples/pagos";

export interface GastoEntrante {
  chatId: number;
  rutaLocal: string;
  nombreArchivoOriginal: string;
  mimeType?: string;
  datos: DatosFactura;
  /** true si este adjunto vino de la cola de revisión de correo uno a uno — ver PropuestaGasto.deColaCorreo. */
  deColaCorreo?: boolean;
  /**
   * Botón «Crear el gasto ahora, sin conciliar» (caso Anthropic, 08-10-2026): el operador confirma que el movimiento ya
   * conciliado que frenaba la propuesta es otro cargo. Se omite ese freno y sale la propuesta normal; la conciliación se
   * hace después, cuando el cargo real aparezca en el banco.
   */
  crearAunqueHayaCargoConciliado?: boolean;
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

export function describirCuentaSugerida(
  cuenta: CuentaSugerida,
  tagsCategoria: string[]
): string {
  const respaldo = cuenta.evidencias
    ? `${cuenta.evidencias} documento${cuenta.evidencias === 1 ? "" : "s"} independiente${cuenta.evidencias === 1 ? "" : "s"}`
    : "el historial verificado";
  const esNaturalezaDeViaje = cuenta.aprendidoDe === "viaje" || tagsCategoria.some((tag) =>
    ["transporte", "taxi", "tren", "avion", "hospedaje", "alquilercoche", "peaje", "barco"].includes(tag)
  );
  if (esNaturalezaDeViaje) {
    const naturaleza = tagsCategoria.length > 0 ? ` de ${tagsCategoria.join("/")}` : "";
    const contextoVisible = cuenta.contextoEjemplo?.map((valor) => valor === "ubicacion" ? "ubicación" : valor);
    const contextoEjemplo = contextoVisible?.length
      ? ` Referencia comparable por la misma ${contextoVisible.join(" y ")}: "${cuenta.ejemplo}".`
      : " No se usa ni se muestra otro viaje como referencia si no comparte persona o ubicación.";
    return `seleccionada para este gasto de viaje${naturaleza}, respaldada por ${respaldo}; ` +
      `no está vinculada a un gasto individual. Persona y ubicación no se heredan de otro gasto; ` +
      `solo se muestran cuando este correo/recibo las identifica.` +
      contextoEjemplo;
  }
  const ejemplo = cuenta.ejemplo ? ` Ejemplo de soporte: "${cuenta.ejemplo}".` : "";
  return `identificada ${ETIQUETA_APRENDIDO_DE[cuenta.aprendidoDe]} con ${respaldo}; no está vinculada a otro gasto.` + ejemplo;
}

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
/** Tasa del día (histórica de la fecha del documento; si no, la actual). undefined si ninguna está disponible. Solo para convertir el
 * importe de un recibo cuando el banco aún no muestra el cargo: el cargo real, cuando aparezca, manda al conciliar. */
async function tasaDelDia(fecha: string, origen: string, destino: string): Promise<number | undefined> {
  let tasa: number | undefined;
  try {
    tasa = await obtenerTasaCambioHistorica(fecha, origen, destino);
  } catch (error) {
    console.error("[procesarGastoEntrante] Tasa histórica no disponible para convertir:", error instanceof Error ? error.message : error);
  }
  if (tasa === undefined) {
    try {
      tasa = await obtenerTasaCambioActual(origen, destino);
    } catch (error) {
      console.error("[procesarGastoEntrante] Tasa actual no disponible para convertir:", error instanceof Error ? error.message : error);
    }
  }
  return tasa;
}

export async function procesarGastoEntrante(entrada: GastoEntrante): Promise<ResultadoGastoEntrante> {
  const { chatId, datos } = entrada;

  // La factura manda sobre el contexto: si nombra como COMPRADOR a una sociedad del grupo, el gasto es de esa sociedad, aunque el contexto
  // (dominios, remitente, proyecto) apunte a otra (caso Name.com 28837066, 08-10: iba a Business Atelier Europa SL y se creó en EWORKS).
  // Lo que el operador fijó a mano no se toca.
  const empresaDelComprador = empresaNombradaEnTexto(datos.compradorRazonSocial);
  if (empresaDelComprador && datos.empresaProbable !== empresaDelComprador && !datos.empresaFijadaPorOperador) {
    datos.razon =
      (datos.razon ? `${datos.razon} ` : "") +
      `[La factura va a nombre de «${datos.compradorRazonSocial}»: el gasto es de ${empresaDelComprador}` +
      `${esEmpresaHolded(datos.empresaProbable) ? `, no de ${datos.empresaProbable}` : ""}.]`;
    console.log(`[procesarGastoEntrante] Empresa corregida por el comprador de la factura: ${datos.empresaProbable} → ${empresaDelComprador} («${datos.compradorRazonSocial}»).`);
    datos.empresaProbable = empresaDelComprador;
  }

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

  // No presentar una búsqueda alrededor de hoy como verificación de un recibo sin fecha.
  if (!esFechaDocumentoValida(datos.fecha)) {
    const previo = huellaContenido ? await buscarGastoProcesadoPorIdentidad(empresa, { huellaContenido }) : undefined;
    if (previo?.motivo === "mismo_archivo" && previo.registro.completado === true) {
      await sendTelegramMessage(chatId, `✅ Comprobante duplicado verificado: ya corresponde al gasto ${previo.registro.gastoId}. No se crea ni concilia otro gasto.`);
      return "propuesta_duplicada";
    }
    let busquedaIncompleta = false;
    const cargos = await buscarCargoSinFecha(empresa, { proveedor: datos.proveedor, concepto: datos.concepto, monto: datos.monto, moneda: datos.moneda }).catch(error => {
      busquedaIncompleta = true;
      console.error("[procesarGastoEntrante] Búsqueda sin fecha incompleta", error);
      return [];
    });
    const fechaBancaria = seleccionarFechaBancaria(cargos);
    if (fechaBancaria) {
      // Se usa como referencia bancaria, sin inventar una fecha impresa en el recibo.
      return procesarGastoEntrante({ ...entrada, datos: { ...datos, fecha: fechaBancaria,
        concepto: `${datos.concepto} [Fecha de referencia bancaria: ${fechaBancaria}; recibo sin fecha]` } });
    }
    await guardarGastoPendienteDatos({
      chatId, rutaLocal: entrada.rutaLocal, nombreArchivoOriginal: entrada.nombreArchivoOriginal,
      mimeType: entrada.mimeType, datos, motivo: "fecha", deColaCorreo: entrada.deColaCorreo,
      origenAdjuntoGmail: entrada.origenAdjuntoGmail, correoOrigen: entrada.correoOrigen,
    });
    await sendTelegramMessage(chatId,
      `🔎 ${datos.proveedor || "Gasto"} · ${datos.monto} ${datos.moneda}: el comprobante no tiene una fecha verificable. ` +
      (busquedaIncompleta ? `La consulta bancaria quedó incompleta; se conserva el caso para reintento. ` : `Se buscaron cargos por importe y categoría compatible en los últimos 90 días, incluidos conciliados, sin una coincidencia única. `) +
      `No se ofrece crear otro gasto. ` +
      `Hay que contrastar el correo original, los comprobantes anteriores y los movimientos, incluidos los ya conciliados. ` +
      `No se ha usado la fecha de hoy ni se ha concluido que falte el cargo. La revisión puede retomarse con la fecha documentada sin releer el adjunto.`);
    return "pendiente_datos";
  }



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
  // Un fallo de Holded no demuestra ninguna moneda: nunca se asume «solo EUR» (caso real 2026-09-28: con Holded en 502/503
  // se le dijo a Carlos que USD no era moneda de cuenta de Footprint, que sí las tiene). Si tampoco hay una última lectura
  // buena, se avisa y se deja para reintentar en lugar de continuar con una conclusión inventada.
  const monedasReales = await obtenerMonedasCuentasReales(empresa).catch((error) => {
    const detalle = error instanceof Error ? error.message : String(error);
    console.error("[procesarGastoEntrante] No se pudieron consultar las monedas de las cuentas reales:", error);
    throw new Error(
      `No pude consultar las cuentas de ${empresa} en Holded (${detalle}). No asumo ninguna moneda; el documento queda para reintentar en unos minutos.`
    );
  });
  const monedaOriginal = (datos.moneda || "EUR").toUpperCase().trim();
  const politicaLiquidacion = obtenerPoliticaMonedaLiquidacion(empresa, datos.proveedor, monedaOriginal);
  let montoEquivalenteResuelto = datos.montoEquivalente;
  let monedaEquivalenteResuelta = datos.monedaEquivalente?.toUpperCase().trim();
  // Un equivalente que se aparta de la tasa del día no es una conversión (caso Guadalajara: 174,60 € dicho de pasada en el hilo para unos
  // 4.036,92 MXN que eran ≈ 204,65 €): se ignora y se busca el cargo real en el banco. Sin tasa, se conserva.
  if (montoEquivalenteResuelto !== undefined && monedaEquivalenteResuelta && monedaEquivalenteResuelta !== monedaOriginal) {
    try {
      let tasa: number | undefined;
      try {
        tasa = await obtenerTasaCambioHistorica(datos.fecha, monedaOriginal, monedaEquivalenteResuelta);
      } catch (error) {
        console.error("[procesarGastoEntrante] Tasa histórica no disponible para validar el equivalente:", error instanceof Error ? error.message : error);
      }
      if (tasa === undefined) {
        try {
          tasa = await obtenerTasaCambioActual(monedaOriginal, monedaEquivalenteResuelta);
        } catch (error) {
          console.error("[procesarGastoEntrante] Tasa actual no disponible para validar el equivalente:", error instanceof Error ? error.message : error);
        }
      }
      if (!equivalenteCuadraConTasa({ monto: datos.monto, equivalente: montoEquivalenteResuelto, tasa })) {
        datos.razon =
          (datos.razon ? `${datos.razon} ` : "") +
          `[El equivalente indicado (${montoEquivalenteResuelto} ${monedaEquivalenteResuelta}) no cuadra con la tasa del día para ${datos.monto} ${monedaOriginal} ` +
          `(≈ ${(datos.monto * (tasa as number)).toFixed(2)} ${monedaEquivalenteResuelta}); se ignora y se busca el cargo real en el banco.]`;
        console.log(`[procesarGastoEntrante] Equivalente ${montoEquivalenteResuelto} ${monedaEquivalenteResuelta} descartado: no cuadra con la tasa (${datos.monto} ${monedaOriginal}).`);
        montoEquivalenteResuelto = undefined;
        monedaEquivalenteResuelta = undefined;
      }
    } catch (error) {
      console.error("[procesarGastoEntrante] No se pudo validar el equivalente con la tasa (se conserva):", error instanceof Error ? error.message : error);
    }
  }
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
    const fechaBusqueda = datos.fecha;
    const candidatosLiquidacion = await buscarMovimientosPorTipoCambio(
      empresa,
      {
        monto: datos.monto,
        moneda: monedaOriginal,
        fecha: fechaBusqueda,
        proveedor: datos.proveedor,
        concepto: datos.concepto,
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
      // Norma de resolución autónoma (Carlos, 08-10-2026, caso recibo de Anthropic 24,20 USD en WOBA): si el banco aún no
      // muestra el cargo en la moneda de liquidación, se convierte a la tasa del día y sale la propuesta con botones; la
      // diferencia de cambio se ajusta al conciliar con el cargo real. Misma regla que la rama de moneda sin cuenta propia
      // (PR #404); antes esta rama dejaba el recibo «pendiente de comprobación bancaria» sin proponer nada.
      const tasaLiquidacion = await tasaDelDia(fechaBusqueda, monedaOriginal, politicaLiquidacion.moneda);
      const convertidoLiquidacion = convertirATasa(datos.monto, tasaLiquidacion);
      if (convertidoLiquidacion !== undefined) {
        montoEquivalenteResuelto = convertidoLiquidacion;
        monedaEquivalenteResuelta = politicaLiquidacion.moneda;
        datos.razon =
          (datos.razon ? `${datos.razon} ` : "") +
          `[${datos.monto} ${monedaOriginal} convertidos a ${convertidoLiquidacion.toFixed(2)} ${politicaLiquidacion.moneda} con la tasa del día ` +
          `(${(tasaLiquidacion as number).toPrecision(5)}); liquidación en ${politicaLiquidacion.moneda} según la política de ${empresa}. ` +
          `Todavía no hay en el banco un cargo que coincida; al conciliar con el cargo real se ajusta la diferencia de cambio.]`;
      }
    }
    if (montoEquivalenteResuelto === undefined || monedaEquivalenteResuelta !== politicaLiquidacion.moneda) {
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
          `La liquidación se registra en ${politicaLiquidacion.moneda}. Todavía no hay en el banco un cargo que coincida y tampoco pude ` +
          `obtener ahora la tasa de cambio del día para convertirlo. No hace falta que hagas nada: lo reintento solo en la próxima revisión.`
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
    const fechaBusquedaFx = datos.fecha;
    let busquedaFxIncompleta = false;
    const candidatosFx = await buscarMovimientosPorTipoCambio(
      empresa,
      { monto: datos.monto, moneda: monedaOriginal, fecha: fechaBusquedaFx, proveedor: datos.proveedor, concepto: datos.concepto },
      monedasReales
    ).catch((error) => {
      busquedaFxIncompleta = true;
      console.error("[procesarGastoEntrante] Error buscando movimientos bancarios por tipo de cambio (se sigue con la pregunta manual):", error);
      return [] as Awaited<ReturnType<typeof buscarMovimientosPorTipoCambio>>;
    });

    // Wobi resuelve solo (regla de Carlos, 2026-10-08: nada de preguntar lo que se puede convertir): 1) el único cargo que coincide con la
    // conversión; 2) si hay varios, el más cercano en fecha e importe; 3) si no hay ninguno, la conversión a la tasa del día en EUR/USD,
    // y es la conciliación posterior la que ajusta el cambio contra el cargo real.
    const elegido = cargoUnicoParaEquivalente(candidatosFx) ?? mejorCargoPorCercania(candidatosFx, fechaBusquedaFx);
    if (elegido) {
      montoEquivalenteResuelto = Math.abs(elegido.monto);
      monedaEquivalenteResuelta = elegido.moneda;
      datos.razon =
        (datos.razon ? `${datos.razon} ` : "") +
        (elegido.compatibilidad === "por_confirmar"
          ? `[Cargo bancario más probable, con nombre distinto (por confirmar): ${describirMovimientoMultimoneda(elegido)}.]`
          : `[Resuelto automáticamente contra el cargo bancario que coincide con la conversión: ${describirMovimientoMultimoneda(elegido)}.]`);
    } else {
      const destino = monedaDestinoPreferida(monedasReales);
      let tasa: number | undefined;
      if (destino) {
        try {
          tasa = await obtenerTasaCambioHistorica(fechaBusquedaFx, monedaOriginal, destino);
        } catch (error) {
          console.error("[procesarGastoEntrante] Tasa histórica no disponible para convertir:", error instanceof Error ? error.message : error);
        }
        if (tasa === undefined) {
          try {
            tasa = await obtenerTasaCambioActual(monedaOriginal, destino);
          } catch (error) {
            console.error("[procesarGastoEntrante] Tasa actual no disponible para convertir:", error instanceof Error ? error.message : error);
          }
        }
      }
      const convertido = convertirATasa(datos.monto, tasa);
      if (destino && convertido !== undefined) {
        montoEquivalenteResuelto = convertido;
        monedaEquivalenteResuelta = destino;
        datos.razon =
          (datos.razon ? `${datos.razon} ` : "") +
          `[${datos.monto} ${monedaOriginal} convertidos a ${convertido.toFixed(2)} ${destino} con la tasa del día (${(tasa as number).toPrecision(5)}). ` +
          `${busquedaFxIncompleta ? "La consulta de cargos en Holded quedó incompleta; " : "Todavía no hay en el banco un cargo que coincida; "}` +
          `al conciliar con el cargo real se ajusta la diferencia de cambio.]`;
      } else {
        // Último recurso: sin ninguna tasa disponible (ni histórica ni actual) no se puede convertir. Se avisa y se reintenta solo.
        await sendTelegramMessage(
          chatId,
          `📄 «${datos.proveedor || "proveedor desconocido"}» · ${datos.monto} ${monedaOriginal} (${datos.fecha || "sin fecha"}, ${empresa}): no pude obtener ahora la tasa de cambio ` +
            `del día para convertirlo. No hace falta que hagas nada: lo reintento solo en la próxima revisión.`
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
      // Gasto ya procesado, pero el archivo de ahora puede ser un soporte mejor que los que tiene (caso Antaris: solo una
      // captura de mapa). Si el gasto no tiene ya este mismo archivo y su soporte son solo imágenes, se ofrece adjuntarlo
      // con el flujo normal («Es este (#1)»). Si no se pueden leer sus adjuntos, se bloquea como siempre.
      let ofrecerSoporteDistinto = false;
      if (duplicadoInterno.motivo === "mismo_numero_y_proveedor") {
        try {
          const adjuntosDelGasto = await descargarAdjuntosCompraHolded(duplicadoInterno.registro.empresa, duplicadoInterno.registro.gastoId);
          ofrecerSoporteDistinto = debeOfrecerSoporteDistinto({ huellaContenido, mimeTypeNuevo: entrada.mimeType, adjuntosDelGasto });
        } catch (error) {
          console.error("[procesarGastoEntrante] No se pudieron leer los adjuntos del gasto existente; se bloquea como siempre:", error instanceof Error ? error.message : error);
        }
      }
      if (ofrecerSoporteDistinto) {
        const registrada = duplicadoInterno.registro.identidad;
        candidatoRecuperacion = {
          id: duplicadoInterno.registro.gastoId,
          contactName: registrada?.proveedor || datos.proveedor,
          fecha: registrada?.fecha || datos.fecha,
          total: registrada?.monto ?? montoParaHolded,
          descripcion: registrada?.concepto || datos.concepto,
          documentNumber: registrada?.numeroDocumento || datos.numeroDocumento,
          moneda: registrada?.moneda || monedaParaHolded,
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
        // Mismo freno que el aviso de propuesta pendiente: un correo con muchos adjuntos repetía este aviso por cada uno.
        const claveAviso = `duplicado:${duplicadoInterno.registro.gastoId}:${entrada.correoOrigen?.mensajeIdGmail ?? entrada.nombreArchivoOriginal}`;
        if (!(await frenoAvisoPropuesta.puedeAvisar(claveAviso))) {
          console.log(`[procesarGastoEntrante] Aviso de gasto ya procesado omitido (ya se avisó hace poco): ${claveAviso}`);
          return "propuesta_duplicada";
        }
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
        fecha: datos.fecha,
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
    try {
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
        `⚠️ Holded siguió sin completar la verificación estricta de duplicados después de los reintentos seguros (${detalle}). ` +
          `Por seguridad NO propuse ni creé el gasto. Conservé este correo/documento sin leer: puedes reintentar ` +
          `la misma verificación o dejar solo este pendiente y continuar con los demás correos.`,
        botonesFalloTemporalVerificacionPendiente(pendiente.id)
      );
    } catch (errorStore) {
      console.error("[procesarGastoEntrante] Error guardando/publicando reintento de duplicados:", errorStore);
      await sendTelegramMessage(
        chatId,
        `⚠️ No pude completar la verificación estricta de duplicados en Holded (${detalle}). Por seguridad NO propuse ni creé el gasto. ` +
          `El correo sigue sin leer; no pude publicar sus controles de recuperación y requiere un nuevo intento desde el chat.`
      ).catch(() => {});
    }
    return "pendiente_datos";
  }

  if (movimientosYaConciliados.length > 0 && entrada.crearAunqueHayaCargoConciliado) {
    console.log("[procesarGastoEntrante] El operador confirmó que el movimiento ya conciliado es otro cargo; se propone crear sin conciliar:", {
      proveedor: datos.proveedor, monto: montoParaHolded, moneda: monedaParaHolded, movimientos: movimientosYaConciliados.map((m) => m.movementId ?? m.descripcion),
    });
    movimientosYaConciliados = [];
  }
  if (movimientosYaConciliados.length > 0) {
    // Mismo correo con esta misma pregunta ya viva: no se repite el aviso (caso real 08-10-2026: el mensaje de Anthropic salió dos veces).
    // Si la comprobación falla no se asume nada: se manda el aviso como siempre (mejor repetido que perdido).
    let yaPreguntado: { id: string } | undefined;
    if (entrada.correoOrigen?.mensajeIdGmail) {
      try {
        yaPreguntado = (await obtenerGastosPendienteDatosPorChat(chatId))
          .find((p) => p.motivo === "verificacion_duplicado" && p.correoOrigen?.mensajeIdGmail === entrada.correoOrigen?.mensajeIdGmail);
      } catch (error) {
        console.error("[procesarGastoEntrante] No se pudo comprobar si la verificación ya estaba pendiente; se avisa igualmente:", error);
      }
    }
    if (yaPreguntado) {
      console.log("[procesarGastoEntrante] Verificación de duplicado ya pendiente para este correo; no se repite el aviso:", yaPreguntado.id);
      return "pendiente_datos";
    }
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
      // Caso real (Carlos, 2026-09-30): «resuelve la propuesta existente» dejaba el chat sin botones, porque esa
      // propuesta estaba muchos mensajes más arriba (correo de 5 adjuntos). La decisión pendiente va siempre al
      // final del chat, con sus botones; el aviso explica por qué no se propone otra.
      // Un aviso por propuesta cada 10 min (core/gastos/avisoPropuestaPendiente.ts): un correo con muchos adjuntos, un reintento
      // o un reinicio ya no llenan el chat con el mismo mensaje. La decisión sigue pendiente en el aviso ya enviado.
      if (!(await frenoAvisoPropuesta.puedeAvisar(propuestaYaPendiente.id))) {
        console.log(`[procesarGastoEntrante] Aviso de propuesta pendiente omitido (ya se avisó hace menos de 10 min): ${propuestaYaPendiente.id}`);
        return "propuesta_pendiente_existente";
      }
      const encabezado =
        `📄 "${entrada.nombreArchivoOriginal}" ya tiene una propuesta pendiente para este mismo correo ` +
        `(${propuestaYaPendiente.proveedor} — ${propuestaYaPendiente.monto.toFixed(2)} ${propuestaYaPendiente.moneda}). ` +
        `No creé otra: te la reenvío aquí para que la resuelvas.${notaNumeroDocumento}`;
      try {
        await reenviarPropuestaGasto(propuestaYaPendiente, encabezado);
      } catch (error) {
        console.error("[procesarGastoEntrante] No se pudo reenviar la propuesta pendiente existente:", error);
        await sendTelegramMessage(chatId, `${encabezado}\n\n⚠️ No pude reenviarla con botones; escríbeme «reenvía los botones de ${propuestaYaPendiente.proveedor}».`);
      }
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
  // Se captura una sola vez para reutilizarla tanto en inferirCuentaGasto como en la propuesta
  // persistida (ver PropuestaGasto.ticketDeEquipo) — misma señal, nunca recalculada distinto.
  const ticketDeEquipo = entrada.deColaCorreo === true && esRemitenteDelGrupo(entrada.correoOrigen?.de);
  const cuentaSugerida =
    candidatos.length === 0
      ? await inferirCuentaGasto(empresa, {
          proveedor: datos.proveedor,
          concepto: datos.concepto,
          personaAsociada: datos.personaAsociada,
          contextoDeViaje: datos.contextoDeViaje,
          reciboSimplificado: datos.reciboSimplificado,
          ticketDeEquipo,
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
    cuentaSugerida?.tags,
    undefined,
    datos.contextoDeViaje
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
    personaAsociada: datos.personaAsociada,
    deColaCorreo: entrada.deColaCorreo,
    origenAdjuntoGmail: entrada.origenAdjuntoGmail,
    correoOrigen: entrada.correoOrigen,
    huellaContenido,
    // Se persisten aunque candidatos.length>0 (cuentaSugerida no se calculó en ese caso): si más
    // adelante se dispara una reinferencia (prepararPropuestaFinalGasto, gastoCallbackHandler.ts),
    // debe poder recuperar la misma señal que tenía ESTE documento, no perderla en silencio.
    contextoDeViaje: datos.contextoDeViaje,
    reciboSimplificado: datos.reciboSimplificado,
    ticketDeEquipo,
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

  // Aviso (nunca bloqueo): ¿ya hay un gasto de la MISMA estancia de hotel? El recibo de Booking y la factura del hotel llegan por
  // correos distintos, con números distintos, y son el mismo gasto (caso Hotel101 Madrid, 232,20 € vs 242,19 €).
  let notaMismaEstancia = "";
  try {
    const mismas = await buscarMismaEstanciaRegistrada(
      empresa,
      { concepto: datos.concepto, monto: montoParaHolded, moneda: monedaParaHolded },
      { fecha: datos.fecha, excluirMensajeIdGmail: entrada.correoOrigen?.mensajeIdGmail, excluirGastoIds: candidatos.map((c) => c.id) }
    );
    if (mismas.length > 0) {
      notaMismaEstancia =
        `⚠️ Posible MISMA estancia ya registrada: ` +
        mismas.map((m) => `gasto ${m.gastoId.slice(0, 8)} (${m.proveedor}, ${Number.isFinite(m.monto) ? m.monto.toFixed(2) : "?"} ${m.moneda}, ${m.fecha || "sin fecha"})`).join("; ") +
        `. El recibo de Booking y la factura del hotel de una misma estancia son UN solo gasto: si lo es, no lo crees — cancela y decide cuál conservar ` +
        `(lo normal es la factura del hotel, con el pago del recibo aplicado a ella).`;
    }
  } catch (error) {
    console.error("[procesarGastoEntrante] No se pudo comprobar si el hospedaje ya estaba registrado (el aviso se omite):", error instanceof Error ? error.message : error);
  }
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
    if (notaMismaEstancia) lineasTexto.push(``, notaMismaEstancia);
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

    const trazaBusqueda = crearTrazaBusqueda();
    let movimientoBancario: Awaited<ReturnType<typeof buscarMovimientoSimilar>>[number] | undefined;
    let candidatosMovAmbiguos: Awaited<ReturnType<typeof buscarMovimientoSimilar>> = [];
    let movimientoAproximado: Awaited<ReturnType<typeof buscarMovimientoAproximado>>[number] | undefined;
    let otrosAproximados = 0;
    // Si Holded falla a media búsqueda no se puede afirmar «no hay cargo por ese importe»; tampoco se ofrece uno mayor.
    let busquedaCargoCompleta = true;
    try {
      const candidatosMov = await buscarMovimientoSimilar(
        empresa,
        { monto: montoParaHolded, fecha: datos.fecha, moneda: monedaParaHolded, proveedor: datos.proveedor, concepto: datos.concepto, incluirPorConfirmar: true, traza: trazaBusqueda },
        toleranciaMov
      );
      // Un cargo que solo «por confirmar» (nombre distinto) es la última opción: si hay uno aproximado que sí coincide
      // por nombre, gana este último.
      const soloPorConfirmar = candidatosMov.length > 0 && candidatosMov.every((c) => c.compatibilidad === "por_confirmar");
      const aproximadosPrevios = soloPorConfirmar && !esProveedorNoIdentificado(datos.proveedor)
        ? await buscarMovimientoAproximado(empresa, { monto: montoParaHolded, fecha: datos.fecha, moneda: monedaParaHolded, proveedor: datos.proveedor })
        : [];
      if (aproximadosPrevios.length > 0) {
        movimientoAproximado = { ...aproximadosPrevios[0], origenCoincidencia: "aproximada" };
        otrosAproximados = aproximadosPrevios.length - 1;
      } else if (candidatosMov.length === 1) movimientoBancario = { ...candidatosMov[0], origenCoincidencia: "exacta" };
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
          fecha: datos.fecha,
          moneda: monedaParaHolded,
          proveedor: datos.proveedor,
        });
        if (candidatosAprox.length > 0) {
          movimientoAproximado = { ...candidatosAprox[0], origenCoincidencia: "aproximada" };
          otrosAproximados = candidatosAprox.length - 1;
        }
      }
    } catch (error) {
      busquedaCargoCompleta = false;
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
            fecha: datos.fecha,
            proveedor: datos.proveedor,
            concepto: datos.concepto,
            incluirPorConfirmar: true,
            repartoConPendientes: {},
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
            { monto: montoParaHolded, fecha: datos.fecha, proveedor: datos.proveedor },
            otrasMonedas
          );
        } catch (error) {
          console.error("[procesarGastoEntrante] Error buscando movimiento en moneda alternativa:", error);
        }
      }
    }

    // Último recurso (cargoMayor.ts, caso Go Rent A Car): un cargo MAYOR del mismo proveedor del que este gasto puede
    // ser solo una parte. Se ofrece como opción a elegir; nunca se recomienda ni se concilia solo.
    let movimientosCargoMayor: Awaited<ReturnType<typeof buscarCargoMayorDelProveedor>> = [];
    if (!movimientoBancario && !movimientoAproximado && candidatosMovAmbiguos.length === 0 && movimientosTipoCambio.length === 0 &&
        !movimientoMonedaAlternativa && busquedaCargoCompleta && !esProveedorNoIdentificado(datos.proveedor)) {
      try {
        movimientosCargoMayor = await buscarCargoMayorDelProveedor(
          empresa, { monto: montoParaHolded, fecha: datos.fecha, moneda: monedaParaHolded, proveedor: datos.proveedor, concepto: datos.concepto }
        );
      } catch (error) {
        console.error("[procesarGastoEntrante] Error buscando un cargo mayor del proveedor:", error);
      }
    }

    // Recibo cobrado en varios pagos (fase de observación) + guardia: un movimiento anterior al gasto no se propone como coincidencia.
    let notaPagosMultiples = "";
    try {
      const pm = await evaluarPagosMultiples({
        empresa, moneda: monedaParaHolded, total: montoParaHolded, fechaGasto: datos.fecha, pagos: datos.pagos,
        aproximada: movimientoAproximado ? { fecha: movimientoAproximado.fecha, monto: movimientoAproximado.monto, descripcion: movimientoAproximado.descripcion } : undefined,
      });
      if (pm.descartarAproximado) { movimientoAproximado = undefined; if (!movimientoBancario) otrosAproximados = 0; }
      notaPagosMultiples = pm.nota;
    } catch (error) { console.error("[procesarGastoEntrante] Error evaluando pagos múltiples (no crítico):", error instanceof Error ? error.message : error); }

    const notaAproximacion = usarEquivalente
      ? monedaParaHolded === "EUR"
        ? ` (monto aproximado — la factura está en ${monedaOriginal} y el banco convierte a EUR con su propio ` +
          `tipo de cambio, puede diferir unos céntimos del valor exacto)`
        : ` (monto aproximado — puede diferir unos céntimos del valor exacto registrado por el banco)`
      : "";

    // Si el cargo vive en una cuenta de otra moneda, se dice: el importe mostrado es su equivalente contable y al
    // conciliar el gasto se registrará en la moneda real del cargo (caso real Gomerco, 2026-09-29).
    const notaOtraMoneda = (m: { montoNativo?: number; monedaNativa?: string; monto: number; moneda: string } | undefined): string =>
      m?.monedaNativa && m.montoNativo !== undefined
        ? `\n💱 Ese cargo salió de una cuenta en ${m.monedaNativa}: son ${m.montoNativo.toFixed(2)} ${m.monedaNativa} ` +
          `(${m.monto.toFixed(2)} ${m.moneda} es su equivalente contable). Al aprobar "Crear y conciliar", el gasto se registrará en ` +
          `${m.monedaNativa} por ese importe para que la conciliación quede sin diferencia.`
        : "";
    const notaMovimiento = movimientoBancario
      ? `\n\n💳 Encontré un movimiento bancario real sin conciliar que coincide en monto y fecha: ` +
        `"${movimientoBancario.descripcion || "(sin descripción)"}" — ${movimientoBancario.monto.toFixed(2)} ${movimientoBancario.moneda}${notaAproximacion} ` +
        `(${movimientoBancario.fecha}). El cargo ya está en el banco, solo falta registrarlo en Compras.` +
        notaOtraMoneda(movimientoBancario) +
        (movimientoBancario.compatibilidad === "por_confirmar"
          ? `\n⚠️ El nombre del cargo no coincide con el proveedor ("${datos.proveedor}"): se sugiere solo porque coinciden importe, moneda y fecha. ` +
            `Confírmalo antes de aprobar "Crear y conciliar"; si lo confirmas, Wobi recordará este nombre para la próxima vez.`
          : "")
      : movimientoAproximado
        ? `\n\n💳 No encontré un movimiento EXACTO, pero sí uno parecido — nombre reconocible y monto cercano (diferencia de ` +
          `${movimientoAproximado.diferenciaMonto.toFixed(2)} ${movimientoAproximado.moneda}, probablemente por cómo se calculó el ` +
          `equivalente): "${movimientoAproximado.descripcion || "(sin descripción)"}" — ${movimientoAproximado.monto.toFixed(2)} ` +
          `${movimientoAproximado.moneda} (${movimientoAproximado.fecha}). Si es el mismo cargo, aprueba "Crear y conciliar" — revísalo antes si no estás seguro.` +
          notaOtraMoneda(movimientoAproximado) +
          (otrosAproximados > 0
            ? ` (hay ${otrosAproximados} movimiento(s) parecido(s) más de estos días — si este no es el correcto, dímelo y busco entre esos.)`
            : "")
        : candidatosMovAmbiguos.length > 0
          ? `\n\n💳 Encontré ${candidatosMovAmbiguos.length} movimientos bancarios parecidos, no sé cuál es el correcto:\n` +
            candidatosMovAmbiguos
              .map((m, i) => `  ${i + 1}. "${m.descripcion || "(sin descripción)"}" — ${m.monto.toFixed(2)} ${m.moneda} (${m.fecha})${m.compatibilidad === "por_confirmar" ? " ⚠️ nombre distinto" : m.compatibilidad === "aprendido" ? " ✔ confirmado antes para este proveedor" : ""}`)
              .join("\n") +
            `\nMarca "🔗 Conciliar con #N" abajo (o "Crear (sin conciliar)" si ninguno es) y aprueba tu selección.`
          : movimientosTipoCambio.length > 0
            ? `\n\n💱 No apareció el cargo por ${importeTexto}, pero encontré ${movimientosTipoCambio.length === 1 ? "esta alternativa" : "estas alternativas"} ` +
              `en otra moneda/cuenta de ${empresa}, calculando primero el equivalente con la tasa histórica de referencia:\n` +
              movimientosTipoCambio.map((m, i) => describirMovimientoMultimoneda(m, i)).join("\n") +
              `\nMarca "🔗 Conciliar con #N" abajo si reconoces el cargo, o "Crear (sin conciliar)" si ninguno corresponde. ` +
              `Wobi no elegirá ni conciliará por su cuenta una coincidencia cambiaria; si marcas una, ajustaré la tasa de cambio del gasto a ese cargo para que la conciliación quede sin diferencia.`
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
            : movimientosCargoMayor.length > 0
            ? notaCargosMayores(
                movimientosCargoMayor,
                { monto: montoParaHolded, moneda: monedaParaHolded, proveedor: datos.proveedor },
                { hayCorreoOrigen: Boolean(propuesta.correoOrigen) }
              )
            : `\n\n💳 No encontré ningún movimiento bancario sin conciliar que coincida con ${importeTexto}` +
              (!esProveedorNoIdentificado(datos.proveedor)
                ? " — ni exacto ni aproximado por nombre y monto cercano"
                : " (búsqueda exacta — no hay un nombre real de proveedor para buscar por similitud)") +
              ` cerca del ${datos.fecha}. Si ya salió del banco, dime la fecha exacta del cargo o revísalo en Holded. ` +
              `Puedes crear el gasto sin conciliar (se vuelve a comprobar que no esté duplicado) y conciliarlo cuando aparezca el cargo.` +
              (describirTrazaBusqueda(trazaBusqueda) ? `\n${describirTrazaBusqueda(trazaBusqueda)}` : "");

    // A efectos de qué botones ofrecer (abajo), un match aproximado cuenta
    // igual que uno exacto. El movimiento recomendado se guarda completo
    // junto con la propuesta: al aprobar “Crear y conciliar” se usa ese
    // mismo accountId/movementId y no se repite una búsqueda mutable.
    if (movimientoAproximado) movimientoBancario = movimientoAproximado;
    const movimientosParaElegir = candidatosMovAmbiguos.length > 0
      ? candidatosMovAmbiguos
      : movimientosTipoCambio.length > 0 ? movimientosTipoCambio : movimientosCargoMayor;
    const movimientosParaPersistir = movimientoBancario ? [movimientoBancario] : movimientosParaElegir;

    // Estos dos campos forman una sola promesa al operador: mostrar
    // “Crear y conciliar” solo si el movimiento exacto quedó durablemente
    // ligado a la propuesta. Un fallo parcial aborta antes de publicar los
    // botones; nunca se ofrece una acción que después tenga que buscar de
    // nuevo y pueda perder el candidato mostrado.
    const propuestaConBanco = await guardarVinculoBancarioPropuesta(
      propuesta, movimientosParaPersistir, Boolean(movimientoBancario)
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
      ? `\nCuenta contable: ${describirCuentaSugerida(cuentaSugerida, tagsCategoria)}` + notaTags
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
    ].join("\n") + notaCuenta + (notaTicket ? `\n\n${notaTicket}` : "") + (notaMismaEstancia ? `\n\n${notaMismaEstancia}` : "") + notaMovimiento + notaPagosMultiples;

    // Publicar desde el mismo estado que acaba de quedar guardado. La propuesta
    // inicial aún no tenía banco y los controles ocultaban las acciones válidas.
    botones = construirTecladoGasto(propuestaConBanco, opcionesTecladoDesdePropuesta(propuestaConBanco));
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

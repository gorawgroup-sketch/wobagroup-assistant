import {
  actualizarMessageIdGasto,
  actualizarFlagMovimientoBancarioGasto,
  actualizarMovimientosAmbiguosPropuestaGasto,
  type PropuestaGasto,
} from "./gastoProposalSheet";
import { construirTecladoGasto, opcionesTecladoDesdePropuesta } from "./gastoTeclado";
import { sendTelegramMessageWithButtons } from "../telegram/client";
import { buscarMovimientoSimilar, buscarMovimientoAproximado } from "../holded/write";

/**
 * Bug real encontrado en vivo (2026-09-07, y confirmado que ya había pasado antes el 2026-09-02 con
 * otra factura — "JESUS GOMEZ TARRIÑO", 3448.28€): crearPropuestaGasto (gastoProposalSheet.ts) guarda
 * la propuesta en Sheets con messageId=0 ANTES de mandar el mensaje real de Telegram — si algo
 * interrumpe el proceso entre esos dos pasos (una caída transitoria de la API de Telegram, un
 * redeploy justo en ese momento, cualquier excepción no capturada en el tramo intermedio que arma el
 * texto/botones), la propuesta queda huérfana: existe completa en Sheets, pero Carlos nunca vio
 * ningún mensaje con botones — "para ti ya pasó, pero el chat no lo muestra", como lo describió él
 * mismo. Peor todavía: buscarPropuestaGastoPendiente (el chequeo de "no mandes una segunda propuesta
 * para el mismo documento") encuentra esta propuesta huérfana igual que una real, y le dice a Carlos
 * "revisa esa antes" — señalando un mensaje que jamás existió, dejándolo sin ninguna vía real para
 * resolverlo salvo pedir ayuda manual.
 *
 * Esta función cierra el hueco: reenvía los botones reales de una propuesta ya completa (nueva o
 * huérfana) como mensaje NUEVO al final del chat, y repunta la propuesta a ese mensaje. La reutilizan
 * tanto procesarGastoEntrante.ts (cuando detecta que la propuesta "ya pendiente" nunca se entregó,
 * messageId=0) como reenviarBotonesPropuestaGasto.ts (tool conversacional para cuando el usuario pide
 * confirmar en texto libre una propuesta cuyos botones quedaron fuera de vista).
 *
 * Hallazgo real de auditoría posterior (mismo día): la primera versión mandaba un resumen mucho más
 * pobre que el mensaje original de una propuesta (sin desglose de IVA, sin cuenta contable, sin decir
 * si había o no un movimiento bancario para conciliar) — Carlos: "no me das detalles, como sueles
 * hacerlo... no sé si esto tiene para conciliar... con esto no puedo conciliar tan fácilmente". Ahora
 * reconstruye el mismo nivel de detalle a partir de los campos YA guardados en la propuesta — y, si
 * una propuesta huérfana se interrumpió ANTES de completar la búsqueda de movimiento bancario
 * (hayMovimientoBancario todavía undefined), la repite en vivo en vez de dejar la duda sin resolver —
 * mismo criterio que ya usa aplicarCorreccionMoneda (gastoCallbackHandler.ts) tras corregir la moneda.
 */
export async function reenviarPropuestaGasto(propuestaInicial: PropuestaGasto, encabezado: string): Promise<number> {
  let propuesta = propuestaInicial;

  if (propuesta.hayMovimientoBancario === undefined && propuesta.candidatos.length === 0) {
    let movimientoEncontrado = false;
    // Hallazgo real de auditoría: la primera versión solo distinguía "1 match exacto" de "0
    // matches" — cuando hay VARIOS matches exactos igual de parecidos (ninguno único), ninguna de
    // las dos ramas aplicaba, así que se perdían en silencio en vez de ofrecerse como "Conciliar con
    // #N" — mismo criterio que ya usa aplicarCorreccionMoneda (gastoCallbackHandler.ts) y el flujo
    // original (procesarGastoEntrante.ts) para este mismo caso.
    let movimientosAmbiguos: Awaited<ReturnType<typeof buscarMovimientoSimilar>> = [];
    try {
      const exactos = await buscarMovimientoSimilar(propuesta.empresa, {
        monto: propuesta.monto,
        fecha: propuesta.fecha,
        moneda: propuesta.moneda,
      });
      if (exactos.length === 1) {
        movimientoEncontrado = true;
      } else if (exactos.length > 1) {
        movimientosAmbiguos = exactos;
      } else if (propuesta.proveedor) {
        const aproximados = await buscarMovimientoAproximado(propuesta.empresa, {
          monto: propuesta.monto,
          fecha: propuesta.fecha,
          moneda: propuesta.moneda,
          proveedor: propuesta.proveedor,
        });
        movimientoEncontrado = aproximados.length > 0;
      }
    } catch (error) {
      console.error("[reenviarPropuestaGasto] Error buscando movimiento bancario (no crítico):", error);
    }
    await actualizarFlagMovimientoBancarioGasto(propuesta.id, movimientoEncontrado).catch((error) =>
      console.error("[reenviarPropuestaGasto] Error guardando el flag de movimiento bancario (no crítico):", error)
    );
    if (movimientosAmbiguos.length > 0) {
      await actualizarMovimientosAmbiguosPropuestaGasto(propuesta.id, movimientosAmbiguos).catch((error) =>
        console.error("[reenviarPropuestaGasto] Error guardando los movimientos ambiguos (no crítico):", error)
      );
    }
    propuesta = { ...propuesta, hayMovimientoBancario: movimientoEncontrado, movimientosAmbiguos };
  }

  const teclado = construirTecladoGasto(propuesta, opcionesTecladoDesdePropuesta(propuesta));

  const desgloseIva = propuesta.lineas
    .map((l) => `  • ${l.concepto || "(línea)"}: ${l.base.toFixed(2)} ${propuesta.moneda} + IVA ${l.tipoIvaPct}%`)
    .join("\n");

  const notaCuenta = propuesta.cuentaId
    ? `\nCuenta contable: ya identificada${propuesta.cuentaTags && propuesta.cuentaTags.length > 0 ? ` (tags: ${propuesta.cuentaTags.join(", ")})` : ""}`
    : `\nCuenta contable: no encontré una categoría real parecida ya en uso — Holded usará su cuenta por defecto.`;

  const notaCandidatos =
    propuesta.candidatos.length > 0
      ? `\n\nYa hay ${propuesta.candidatos.length === 1 ? "un gasto" : `${propuesta.candidatos.length} gastos`} parecido(s) en Holded que podría(n) corresponder:\n` +
        propuesta.candidatos
          .map((c, i) => `  ${i + 1}. ${c.contactName} — ${c.total.toFixed(2)} € (${c.fecha}) — ${c.descripcion}`)
          .join("\n") +
        `\nRevisa los botones para adjuntar el comprobante a uno de estos, o crear uno nuevo.`
      : "";

  const notaMovimiento =
    propuesta.candidatos.length > 0
      ? ""
      : propuesta.hayMovimientoBancario
        ? `\n\n💳 Sí hay un movimiento bancario real sin conciliar que coincide en monto y fecha — puedes usar "Crear y conciliar".`
        : propuesta.movimientosAmbiguos && propuesta.movimientosAmbiguos.length > 0
          ? `\n\n💳 Encontré ${propuesta.movimientosAmbiguos.length} movimientos bancarios parecidos, no sé cuál es el correcto — marca "Conciliar con #N" en el teclado.`
          : `\n\n💳 No encontré ningún movimiento bancario sin conciliar que coincida con este monto/fecha — revísalo a mano en Holded si ya salió del banco.`;

  const texto =
    `${encabezado}\n\n` +
    `Empresa: ${propuesta.empresa}\n` +
    `Proveedor: ${propuesta.proveedor}\n` +
    `Importe: ${propuesta.monto.toFixed(2)} ${propuesta.moneda}\n` +
    `Fecha: ${propuesta.fecha}\n` +
    (propuesta.numeroDocumento ? `Número de documento: ${propuesta.numeroDocumento}\n` : "") +
    `Concepto: ${propuesta.concepto}\n` +
    `Desglose de IVA:\n${desgloseIva}` +
    notaCuenta +
    notaCandidatos +
    notaMovimiento;

  const messageId = await sendTelegramMessageWithButtons(propuesta.chatId, texto, teclado);
  await actualizarMessageIdGasto(propuesta.id, messageId).catch((error) =>
    console.error("[reenviarPropuestaGasto] Error actualizando el messageId (no crítico — el mensaje ya se mandó):", error)
  );
  return messageId;
}

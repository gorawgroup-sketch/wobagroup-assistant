import { obtenerPropuestasGastoPorChat, type PropuestaGasto } from "../gastos/gastoProposalSheet";
import { reenviarPropuestaGasto } from "../gastos/reenviarPropuestaGasto";
import { obtenerConciliacionesPendientesPorChat } from "../gastos/conciliacionPendienteStore";
import { obtenerConciliacionesAmbiguasPendientesPorChat } from "../gastos/conciliacionAmbiguaPendienteStore";
import {
  filtrarConciliacionesPorTexto,
  reenviarPreguntaConciliacion,
  reenviarPreguntaConciliacionAmbigua,
} from "../gastos/reenviarPreguntaPendiente";
import { montosCercanos } from "../utils/montos";
import type { ToolDefinition } from "./types";

/**
 * Hallazgo real (caso real Carlos, 2026-09-10 — propuestas de "Agencia Tributaria (AEAT)" y "1688
 * Chen Jin S.L." pendientes a la vez): esta tool nunca tuvo forma de indicar CUÁL propuesta reenviar
 * cuando hay varias — el input_schema no tenía ningún campo, así que sin importar cuántas veces Carlos
 * aclarara cuál quería ("2", "sí", o el nombre completo del proveedor), la tool volvía a devolver la
 * MISMA lista ambigua, en un bucle sin salida real (Claude no tenía ningún parámetro donde pasarle la
 * aclaración de Carlos). Se agrega `cual` (texto libre: proveedor, parte de él, número de la lista tal
 * como se mostró, o el monto) para que el modelo pase la aclaración del usuario y la tool resuelva a
 * UNA propuesta sin volver a preguntar cuando ya alcanza para identificarla sin ambigüedad.
 */
function resolverPropuestaPorTexto(pendientes: PropuestaGasto[], cual: string): PropuestaGasto[] {
  const texto = cual.trim().toLowerCase();
  if (!texto) return pendientes;

  // "2" o "la 2" — número de la lista tal como se le mostró al usuario (1-based).
  const comoIndice = Number(texto.replace(/[^\d]/g, ""));
  if (texto.replace(/[^\d]/g, "") === texto.replace(/\s/g, "") && Number.isInteger(comoIndice) && comoIndice >= 1 && comoIndice <= pendientes.length) {
    return [pendientes[comoIndice - 1]];
  }

  // Hallazgo real de auditoría: un proveedor vacío/en blanco (caso real — extractInvoiceData.ts/
  // extraerGastoDeCorreo.ts pueden dejarlo así cuando no se pudo leer, o gastoProposalSheet.ts al
  // releer una fila con esa columna vacía) hace que `"".includes(texto)` NUNCA aplique, pero
  // `texto.includes("")` es SIEMPRE true (todo string incluye al vacío) — sin este filtro, una
  // propuesta sin proveedor se colaba en CUALQUIER búsqueda por texto, resolviendo a la propuesta
  // equivocada o bloqueando para siempre la resolución de la propuesta real.
  const porProveedor = pendientes.filter(
    (p) => p.proveedor.trim() !== "" && (p.proveedor.toLowerCase().includes(texto) || texto.includes(p.proveedor.toLowerCase()))
  );
  if (porProveedor.length > 0) return porProveedor;

  // Monto tal como lo haya escrito el usuario (con coma o punto decimal, con o sin símbolo de moneda).
  const comoMonto = Number(texto.replace(/[^\d.,]/g, "").replace(",", "."));
  if (Number.isFinite(comoMonto) && comoMonto > 0) {
    const porMonto = pendientes.filter((p) => montosCercanos(p.monto, comoMonto, 0.01));
    if (porMonto.length > 0) return porMonto;
  }

  return pendientes;
}

/**
 * Caso real (2026-09-07): una propuesta de gasto de Uber tenía ya un movimiento bancario
 * coincidente ("Crear y conciliar" disponible), Carlos marcó "💰 Ajustar monto" con el teclado de
 * checkboxes, corrigió el monto por texto libre, y luego — en vez de tocar el botón que reapareció
 * en el mensaje ORIGINAL de la propuesta (arriba en el chat, ya scrolleado tras varios mensajes
 * intermedios) — escribió "sí, créalo y concilia" directo en el chat. El asistente conversacional no
 * tenía ninguna herramienta para reconocer eso: usó por error reintentar_gasto_pendiente (pensada
 * solo para la pregunta de "falta la empresa/moneda" DE ANTES de mandar la propuesta, no para una ya
 * completa esperando la decisión final), esa tool no encontró nada, y terminó diciéndole a Carlos
 * "no tengo herramienta para crear el gasto desde cero, reenvía el recibo" — FALSO (la propuesta
 * seguía viva y completa en Sheets) y además peligroso: reenviar el documento habría arriesgado un
 * gasto duplicado.
 *
 * Diseño: esta tool NUNCA ejecuta la creación/conciliación/cancelación ella misma. Es un invariante
 * ya auditado de este sistema (ver conciliarMovimiento.ts): crear/adjuntar/conciliar un gasto SIEMPRE
 * pasa por un botón real que muestra el match exacto antes de escribir en Holded — nunca se dispara
 * solo porque el modelo interpretó una instrucción en texto libre. Además, gasto_nuevo/
 * gasto_nuevo_conciliar/gasto_cancelar están protegidos en ACCIONES_SENSIBLES (solo superadmin) — esa
 * verificación vive en el router de callback_query real (src/server.ts), así que una tool que llamara
 * directo al handler la saltaría por completo. En vez de eso, esta tool reenvía un mensaje NUEVO
 * (visible, al final del chat) con los MISMOS botones reales de la propuesta — cierra el hueco real
 * (los botones existían pero quedaron fuera de vista) sin romper ninguna de las dos protecciones.
 */
export const reenviarBotonesPropuestaGastoTool: ToolDefinition = {
  name: "reenviar_botones_propuesta_gasto",
  description:
    "Vuelve a mostrar, en un mensaje NUEVO al final del chat, los botones reales (✅ Crear / ✅ Crear y " +
    "conciliar / ❌ Cancelar / etc.) de una propuesta de gasto que sigue pendiente. En este sistema «propuesta» " +
    "SIEMPRE es una propuesta de gasto (un ticket/factura detectado que espera decisión), nunca un presupuesto de " +
    "venta: si el usuario dice «renueva / reenvía / vuelve a mandar / muestra de nuevo los botones de la propuesta " +
    "de X» o «no me salen los botones de X», llama a esta herramienta de inmediato pasando X en 'cual' (proveedor, " +
    "parte del nombre, número de la lista o monto) — no pidas más contexto ni preguntes si es una propuesta de venta. " +
    "También úsala cuando el usuario " +
    "responda en TEXTO LIBRE para aprobar/crear/cancelar esa propuesta (ej. 'créalo', 'sí, créalo y concilia', " +
    "'cancela ese gasto') en vez de tocar los botones del mensaje original. Al renovar, el cargo bancario se vuelve a " +
    "buscar en Holded en vivo. NUNCA crea/cancela/concilia nada " +
    "por sí sola — esas escrituras en Holded siempre requieren que el usuario toque el botón real (mismo " +
    "criterio que el resto del sistema), así que después de llamar a esta tool dile al usuario que toque el " +
    "botón que corresponde a lo que pidió, ya renovado al final del chat. Nunca digas que no hay forma de " +
    "crear el gasto ni pidas que reenvíen el documento — la propuesta ya existe completa. Si hay VARIAS " +
    "propuestas pendientes y el usuario ya dijo cuál quiere (por número de la lista, nombre del proveedor, o " +
    "monto — en cualquier mensaje de la conversación, no solo el último), pásalo en 'cual' para no volver a " +
    "preguntar algo que el usuario ya contestó.",
  input_schema: {
    type: "object",
    properties: {
      cual: {
        type: "string",
        description:
          "Cuál propuesta, cuando el usuario la nombra (ej. «JUST B CUZ») o si hay VARIAS pendientes: tal como lo haya dicho — el número " +
          "de la lista que se le mostró (ej. '2'), el nombre del proveedor o parte de él (ej. 'Chen Jin', " +
          "'AEAT'), o el monto (ej. '8,50'). Omite este campo si solo hay una propuesta pendiente, o si el " +
          "usuario todavía no dijo cuál.",
      },
    },
  },
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (chatId === undefined) {
      return "Error: no se pudo determinar el chat — no se puede reenviar ninguna propuesta de gasto.";
    }

    const cual = typeof input.cual === "string" ? input.cual : "";

    const pendientes = await obtenerPropuestasGastoPorChat(chatId);
    // Caso real (Carlos, 2026-09-28 20:14): «no me diste la transacción con botones» y la decisión pendiente era
    // una pregunta de CONCILIACIÓN («¿conciliar Airalo 12,50 USD?»), no una propuesta: esta tool solo miraba
    // gastoProposalSheet y contestó que no había nada. Una pregunta de conciliación (simple o ambigua) es una
    // decisión pendiente igual de real; se reenvía con sus mismos botones. Se buscan cuando no hay propuestas o
    // cuando lo que nombró el usuario no coincide con ninguna propuesta pero sí con una conciliación.
    // resolverPropuestaPorTexto devuelve el MISMO array cuando nada coincide: esa identidad distingue «no
    // identificada» de «una sola pendiente» (con una única propuesta y un nombre que no es el suyo, antes se
    // reenviaba esa propuesta equivocada en vez de buscar la conciliación que el usuario nombró).
    const porTexto = cual ? resolverPropuestaPorTexto(pendientes, cual) : undefined;
    const propuestaNombrada = porTexto !== undefined && porTexto !== pendientes;
    const candidatasPropuesta = cual ? (propuestaNombrada ? porTexto! : []) : pendientes;
    if (pendientes.length === 0 || (cual && !propuestaNombrada)) {
      const simples = filtrarConciliacionesPorTexto(await obtenerConciliacionesPendientesPorChat(chatId), cual);
      const ambiguas = filtrarConciliacionesPorTexto(await obtenerConciliacionesAmbiguasPendientesPorChat(chatId), cual);
      const total = simples.length + ambiguas.length;
      if (total === 1) {
        const encabezado = "🔁 Pregunta pendiente renovada — toca la decisión que quieras aplicar.";
        const descripcion = simples[0]
          ? (await reenviarPreguntaConciliacion(simples[0], encabezado), simples[0].descripcionGasto)
          : (await reenviarPreguntaConciliacionAmbigua(ambiguas[0], encabezado), ambiguas[0].descripcionGasto);
        return (
          `Listo — el gasto "${descripcion}" ya estaba creado en Holded y lo que esperaba era la pregunta de conciliación: ` +
          "reenvié esa pregunta con sus botones reales al final del chat. Dile al usuario que toque el botón que corresponde " +
          "(esta tool no concilió ni cerró nada)."
        );
      }
      if (total > 1) {
        const lista = [...simples, ...ambiguas].map((c, i) => `${i + 1}. ${c.descripcionGasto}`).join("\n");
        return (
          `No hay propuestas de gasto que coincidan, pero sí ${total} preguntas de conciliación pendientes (gastos ya creados que ` +
          `esperan «¿conciliar?»). Pregúntale al usuario cuál quiere y vuelve a llamar con su respuesta en 'cual':\n${lista}`
        );
      }
      if (pendientes.length === 0) {
        return (
          "No hay ninguna propuesta de gasto ni pregunta de conciliación pendiente en este chat — puede que ya se haya resuelto o cancelado. " +
          "No le pidas al usuario que reenvíe el documento sin más: dile que revise si ya se resolvió, o pídele " +
          "el proveedor/monto para investigar antes de asumir que hay que reenviar nada."
        );
      }
    }

    const resueltas = candidatasPropuesta.length > 0 ? candidatasPropuesta : pendientes;

    if (resueltas.length !== 1) {
      const lista = pendientes
        .map((p, i) => `${i + 1}. ${p.proveedor} — ${p.monto.toFixed(2)} ${p.moneda} (${p.fecha})`)
        .join("\n");
      const notaIntento = cual
        ? ` "${cual}" no alcanzó para identificar una sola (¿coincide con más de una, o con ninguna?) —`
        : "";
      return (
        `Hay ${pendientes.length} propuestas de gasto pendientes en este chat —${notaIntento} pregúntale al ` +
        `usuario cuál es (por proveedor y monto, nunca adivines por orden) antes de reenviar ninguna, y vuelve ` +
        `a llamar a esta herramienta pasando su respuesta en 'cual':\n${lista}`
      );
    }

    const propuesta = resueltas[0];
    await reenviarPropuestaGasto(propuesta, "🔁 Botones renovados — toca la decisión que quieras aplicar.");

    return (
      `Listo — reenvié los botones reales de la propuesta de "${propuesta.proveedor}" (${propuesta.monto.toFixed(2)} ${propuesta.moneda}) ` +
      `al final del chat. Dile al usuario que toque el botón que corresponde a lo que pidió — esta tool no creó, ` +
      `canceló ni concilió nada, eso solo pasa cuando él toque el botón real.`
    );
  },
};
